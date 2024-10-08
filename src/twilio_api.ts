import { Request, Response } from "express";
import expressWs from "express-ws";
import Retell from "retell-sdk";
import { RegisterCallResponse } from "retell-sdk/src/resources";
import twilio, { Twilio } from "twilio";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse";

export class TwilioClient {
  private twilio: Twilio;
  private retellClient: Retell;

  constructor(retellClient: Retell) {
    this.twilio = twilio(
      process.env.TWILIO_ACCOUNT_ID,
      process.env.TWILIO_AUTH_TOKEN,
    );
    this.retellClient = retellClient;
  }

  // Create a new phone number and route it to use this server.
  CreatePhoneNumber = async (areaCode: number, agentId: string) => {
    try {
      const localNumber = await this.twilio
        .availablePhoneNumbers("US")
        .local.list({ areaCode: areaCode, limit: 1 });
      if (!localNumber || localNumber[0] == null)
        throw "No phone numbers of this area code.";

      const phoneNumberObject = await this.twilio.incomingPhoneNumbers.create({
        phoneNumber: localNumber[0].phoneNumber,
        voiceUrl: `${process.env.NGROK_IP_ADDRESS}/twilio-voice-webhook/${agentId}`,
      });
      console.log("Getting phone number:", phoneNumberObject);
      return phoneNumberObject;
    } catch (err) {
      console.error("Create phone number API: ", err);
    }
  };

  // Update this phone number to use provided agent id. Also updates voice URL address.
  RegisterInboundAgent = async (number: string, agentId: string) => {
    try {
      const phoneNumberObjects = await this.twilio.incomingPhoneNumbers.list();
      let numberSid;
      for (const phoneNumberObject of phoneNumberObjects) {
        if (phoneNumberObject.phoneNumber === number) {
          numberSid = phoneNumberObject.sid;
        }
      }
      if (numberSid == null) {
        return console.error(
          "Unable to locate this number in your Twilio account, is the number you used in BCP 47 format?",
        );
      }

      await this.twilio.incomingPhoneNumbers(numberSid).update({
        voiceUrl: `${process.env.NGROK_IP_ADDRESS}/twilio-voice-webhook/${agentId}`,
      });
    } catch (error: any) {
      console.error("failer to retrieve caller information: ", error);
    }
  };

  // Release a phone number
  DeletePhoneNumber = async (phoneNumberKey: string) => {
    await this.twilio.incomingPhoneNumbers(phoneNumberKey).remove();
  };

  // Create an outbound call
  CreatePhoneCall = async (
    fromNumber: string,
    toNumber: string,
    agentId: string,
  ) => {
    try {
      await this.twilio.calls.create({
        machineDetection: "none", // detects if the other party is IVR
        machineDetectionTimeout: 8,
        asyncAmd: "true", // call webhook when determined whether it is machine
        asyncAmdStatusCallback: `${process.env.NGROK_IP_ADDRESS}/twilio-voice-webhook/${agentId}`, // Webhook url for machine detection
        url: `${process.env.NGROK_IP_ADDRESS}/twilio-voice-webhook/${agentId}`, // Webhook url for registering call
        to: toNumber,
        from: fromNumber,
      });
      console.log(`Call from: ${fromNumber} to: ${toNumber}`);
    } catch (error: any) {
      console.error("failer to retrieve caller information: ", error);
    }
  };

  // Use LLM function calling or some kind of parsing to determine when to let AI end the call
  EndCall = async (sid: string) => {
    try {
      const call = await this.twilio.calls(sid).update({
        twiml: "<Response><Hangup></Hangup></Response>",
      });
      console.log("End phone call: ", call);
    } catch (error) {
      console.error("Twilio end error: ", error);
    }
  };

  // Use LLM function calling or some kind of parsing to determine when to transfer away this call
  TransferCall = async (sid: string, transferTo: string) => {
    try {
      const call = await this.twilio.calls(sid).update({
        twiml: `<Response><Dial>${transferTo}</Dial></Response>`,
      });
      console.log("Transfer phone call: ", call);
    } catch (error) {
      console.error("Twilio transfer error: ", error);
    }
  };

  // New method to send SMS
  SendSMS = async (to: string, body: string) => {
    try {
      const message = await this.twilio.messages.create({
        body: body,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
        to: to,
      });
      console.log("SMS sent, SID:", message.sid);
      return message;
    } catch (error) {
      console.error("Error sending SMS:", error);
      throw error;
    }
  };

  /* Twilio voice webhook. This will be called whenever there is an incoming or outgoing call. 
     Register call with Retell at this stage and pass in returned call_id to Retell*/
  ListenTwilioVoiceWebhook = (app: expressWs.Application) => {
    app.post("/make-call/:agent_id", async (req: Request, res: Response) => {
      try {
        const agent_id = req.params.agent_id;
        const { from, to } = req.body;
        await this.CreatePhoneCall(from, to, agent_id);
        res.set("Content-Type", "text/xml");
        res.send("All Good");
      } catch (err) {
        console.error("Error in twilio voice webhook:", err);
        res.status(500).send();
      }
    });

    app.post(
      "/twilio-voice-webhook/:agent_id",
      async (req: Request, res: Response) => {
        //console.log(req.body);
        const agent_id = req.params.agent_id;
        console.log(req.body);
        const { AnsweredBy, Caller, To, CallSid } = req.body;
        try {
          // Respond with TwiML to hang up the call if its machine)

          if (AnsweredBy && AnsweredBy === "machine_start") {
            this.EndCall(req.body.CallSid);
            return;
          } else if (AnsweredBy) {
            return;
          }

          const callResponse: RegisterCallResponse =
            await this.retellClient.call.register({
              agent_id: agent_id,
              audio_websocket_protocol: "twilio",
              audio_encoding: "mulaw",
              sample_rate: 8000,
              from_number: Caller,
              to_number: To,
              retell_llm_dynamic_variables: {
                from_number: Caller,
                to_number: To,
                twilio_call_sid: CallSid,
              },
              metadata: { twilio_call_sid: CallSid },
            });
          if (callResponse) {
            await new Promise((resolve) => setTimeout(resolve, 3000)); // 2 seconds delay
            // Start phone call websocket
            const response = new VoiceResponse();
            const start = response.connect();
            const stream = start.stream({
              url: `wss://api.retellai.com/audio-websocket/${callResponse.call_id}`,
            });
            console.log("Ending stream");
            res.set("Content-Type", "text/xml");
            res.send(response.toString());
          }
        } catch (err) {
          console.error("Error in twilio voice webhook:", err);
          res.status(500).send();
        }
      },
    );
  };
}
