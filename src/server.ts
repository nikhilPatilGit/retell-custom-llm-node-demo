import axios from "axios";
import cors from "cors";
import express, { Request, Response } from "express";
import expressWs from "express-ws";
import { Server as HTTPServer, createServer } from "http";
import { Retell } from "retell-sdk";
import { RegisterCallResponse } from "retell-sdk/resources/call";
import { RawData, WebSocket } from "ws";
import { TwilioClient } from "./twilio_api";
import { CustomLlmRequest, CustomLlmResponse } from "./types";
// Any one of these following LLM clients can be used to generate responses.
// import { DemoLlmClient } from "./llms/llm_azure_openai";
// import { FunctionCallingLlmClient } from "./llms/llm_azure_openai_func_call_end_call";
// import { FunctionCallingLlmClient } from "./llms/llm_azure_openai_func_call";
// import { DemoLlmClient } from "./llms/llm_openrouter";
import { GrokLlmClient } from "./llms/llm_grok";
export class Server {
  private httpServer: HTTPServer;
  public app: expressWs.Application;
  private retellClient: Retell;
  private twilioClient: TwilioClient;

  constructor() {
    this.app = expressWs(express()).app;
    this.httpServer = createServer(this.app);
    this.app.use(express.json());
    this.app.use(cors());
    this.app.use(express.urlencoded({ extended: true }));

    this.retellClient = new Retell({
      apiKey: process.env.RETELL_API_KEY,
    });
    this.twilioClient = new TwilioClient(this.retellClient);
    this.twilioClient.ListenTwilioVoiceWebhook(this.app);

    //this.handleRetellLlmWebSocket();
    //this.handleRegisterCallAPI();
    // this.handleWebhook();
    this.handleBookingWebhook();
    this.handleTakeMessageWebhook(); // Add this line
    //this.handleCalculateWebhook();
    this.handleTransferCallWebhook();

    // If you want to create an outbound call with your number
    // this.twilioClient.CreatePhoneCall(
    //   "+14157122917",
    //   "+14157122912",
    //   "68978b1c29f5ff9c7d7e07e61124d0bb",
    // );
  }

  listen(port: number): void {
    this.app.listen(port);
    console.log("Listening on " + port);
  }

  /* Handle webhook from Retell server. This is used to receive events from Retell server.
     Including call_started, call_ended, call_analyzed */
  handleWebhook() {
    this.app.post("/webhook", (req: Request, res: Response) => {
      if (
        !Retell.verify(
          JSON.stringify(req.body),
          process.env.RETELL_API_KEY,
          req.headers["x-retell-signature"] as string,
        )
      ) {
        console.error("Invalid signature");
        return;
      }
      const content = req.body;
      switch (content.event) {
        case "call_started":
          console.log("Call started event received", content.data.call_id);
          break;
        case "call_ended":
          console.log("Call ended event received", content.data.call_id);
          break;
        case "call_analyzed":
          console.log("Call analyzed event received", content.data.call_id);
          break;
        default:
          console.log("Received an unknown event:", content.event);
      }
      // Acknowledge the receipt of the event
      res.json({ received: true });
    });
  }

  /* Only used for web call frontend to register call so that frontend don't need api key.
     If you are using Retell through phone call, you don't need this API. Because
     this.twilioClient.ListenTwilioVoiceWebhook() will include register-call in its function. */
  handleRegisterCallAPI() {
    this.app.post(
      "/register-call-on-your-server",
      async (req: Request, res: Response) => {
        // Extract agentId from request body; apiKey should be securely stored and not passed from the client
        const { agent_id } = req.body;

        try {
          const callResponse: RegisterCallResponse =
            await this.retellClient.call.register({
              agent_id: agent_id,
              audio_websocket_protocol: "web",
              audio_encoding: "s16le",
              sample_rate: 24000,
            });
          // Send back the successful response to the client
          res.json(callResponse);
        } catch (error) {
          console.error("Error registering call:", error);
          // Send an error response back to the client
          res.status(500).json({ error: "Failed to register call" });
        }
      },
    );
  }

  /* Start a websocket server to exchange text input and output with Retell server. Retell server 
     will send over transcriptions and other information. This server here will be responsible for
     generating responses with LLM and send back to Retell server.*/
  handleRetellLlmWebSocket() {
    this.app.ws(
      "/llm-websocket/:call_id",
      async (ws: WebSocket, req: Request) => {
        try {
          const callId = req.params.call_id;
          //console.log("Handle llm ws for: ", req);

          // Add a delay before proceeding
          await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 seconds delay

          // Send config to Retell server
          const config: CustomLlmResponse = {
            response_type: "config",
            config: {
              auto_reconnect: true,
              call_details: true,
            },
          };
          ws.send(JSON.stringify(config));

          // Start sending the begin message to signal the client is ready.
          const llmClient = new GrokLlmClient(this.twilioClient);

          ws.on("error", (err) => {
            console.error("Error received in LLM websocket client: ", err);
          });
          ws.on("close", (err) => {
            console.error("Closing llm ws for: ", callId);
          });

          ws.on("message", async (data: RawData, isBinary: boolean) => {
            if (isBinary) {
              console.error("Got binary message instead of text in websocket.");
              ws.close(1007, "Cannot find corresponding Retell LLM.");
            }
            const request: CustomLlmRequest = JSON.parse(data.toString());

            // There are 5 types of interaction_type: call_details, ping_pong, update_only,response_required, and reminder_required.
            // Not all of them need to be handled, only response_required and reminder_required.
            if (request.interaction_type === "call_details") {
              // print call details

              llmClient.setCallSid(request.call.metadata.twilio_call_sid);
              console.log("call sid: ", request.call.metadata.twilio_call_sid);

              // Send begin message to start the conversation
              llmClient.BeginMessage(ws);
            } else if (
              request.interaction_type === "reminder_required" ||
              request.interaction_type === "response_required"
            ) {
              console.clear();
              console.log("req", request.call);
              //const callSid = request.call.metadata.twilio_call_sid;
              llmClient.DraftResponse(request, ws, "callSid");
            } else if (request.interaction_type === "ping_pong") {
              let pingpongResponse: CustomLlmResponse = {
                response_type: "ping_pong",
                timestamp: request.timestamp,
              };
              ws.send(JSON.stringify(pingpongResponse));
            } else if (request.interaction_type === "update_only") {
              // process live transcript update if needed
            }
          });
        } catch (err) {
          console.error("Encountered error:", err);
          ws.close(1011, "Encountered error: " + err);
        }
      },
    );
  }

  handleBookingWebhook() {
    this.app.post("/booking", async (req: Request, res: Response) => {
      console.log("Received request:", req.body);
      const { args, call } = req.body;
      console.log("call", call);
      console.log("args", args);
      const {
        name,
        email,
        phone,
        bookingDate,
        numberOfGuest,
        message,
        isCallingFromSameNumber,
      } = args;

      const URL =
        "https://jodhpur.restaurant/wp-json/reservation-api/post/reservation";
      const postTreeApiKey = "myGoodInfo#4545";

      try {
        const response = await axios.post(URL, null, {
          params: {
            name,
            party: numberOfGuest,
            email,
            phone: isCallingFromSameNumber ? call.from_number : phone,
            booking_date: bookingDate,
            message,
          },
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${postTreeApiKey}`,
          },
        });

        console.log("Booking response:", response.data);
        res.json(response.data);
      } catch (error) {
        console.error("Error processing booking request:", error);
        res.status(500).json({
          error: "Error occurred while processing the booking request",
        });
      }
    });
  }

  handleTakeMessageWebhook() {
    this.app.post("/takeMessage", async (req: Request, res: Response) => {
      console.log("Received takeMessage request:", req.body);
      const { args, call } = req.body;
      const { message } = args;
      const phoneNumber = call.from_number;

      try {
        const smsResponse = await this.twilioClient.SendSMS(
          phoneNumber,
          message,
        );
        console.log("SMS sent successfully:", smsResponse.sid);
        res.json({ success: true, messageSid: smsResponse.sid });
      } catch (error) {
        console.error("Error sending SMS:", error);
        res.status(500).json({
          error: "Error occurred while sending the SMS",
        });
      }
    });
  }

  handleCalculateWebhook() {
    this.app.post("/calculate", (req: Request, res: Response) => {
      console.log("Received request:", req.body);

      const { call, name, args } = req.body;

      if (name !== "calculate_sum_total") {
        return res.status(400).json({ error: "Invalid tool name" });
      }

      if (
        !args ||
        !Array.isArray(args.numbers) ||
        !args.numbers.every((num: any) => typeof num === "number")
      ) {
        return res.status(400).json({ error: "Invalid input" });
      }

      const sum = args.numbers.reduce((acc: any, num: any) => acc + num, 0);
      const result = parseFloat(sum.toFixed(3));
      console.log("result", result);
      res.json({ result });
    });
  }

  handleTransferCallWebhook() {
    this.app.post("/transferCall", async (req: Request, res: Response) => {
      try {
        const { args } = req.body;
        console.log(req.body);
        console.log("Twilio Call SID:", args.twilio_call_sid);

        this.twilioClient.TransferCall(args.twilio_call_sid, "+353433342214");

        res.set("Content-Type", "text/xml");
        res.send("Call Transferred");
      } catch (err) {
        console.error("Error in twilio voice webhook:", err);
        res.status(500).send();
      }
    });
  }
}
