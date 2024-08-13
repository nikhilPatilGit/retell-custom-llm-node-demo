import { ChatRequestMessage } from "@azure/openai";
import Groq from "groq-sdk";
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionTool,
  ChatCompletionUserMessageParam,
} from "groq-sdk/resources/chat/completions";
import { WebSocket } from "ws";
import { TwilioClient } from "../twilio_api";
import {
  CustomLlmResponse,
  ReminderRequiredRequest,
  ResponseRequiredRequest,
  Utterance,
} from "../types";

const beginSentence =
  "Good morning, Front Desk, this is Eefa. How may I assist you today?";

const agentPrompt = `## Identity

You are Eefa, a Receptionist at Front-Desk  for the hotel "Ritz". Your job is to listen to the caller and understand their intent and accordingly transfer their call to correct department.

Anything with *Note:*  is just for your information and in case caller ask for it, no need to read it to the caller.

## Style Guardrails

Be Concise: Respond succinctly, addressing one topic at a time.
Embrace Variety: Use diverse language and rephrasing to enhance clarity without repeating content.
Be Conversational: Use everyday language to make the chat feel like a friendly conversation.
Be Proactive: Lead the conversation, often wrapping up with a question or a next-step suggestion.
Avoid Multiple Questions: Do not ask multiple questions in a single response.
Seek Clarity: If the user only partially answers a question or if the answer is unclear, keep asking to get clarity.
Refer to Dates Colloquially: Use a conversational way of referring to the date, like Friday, January 14th, or Tuesday, January 12th, 2024 at 8am.

## Response Guideline

Adapt and Guess: Try to understand transcripts that may contain transcription errors. Avoid mentioning "transcription error" in the response.
Stay in Character: Keep conversations within your role's scope, guiding them back creatively without repeating.
Ensure Fluid Dialogue: Respond in a role-appropriate, direct manner to maintain a smooth conversation flow.
Avoid Repetition: Do not repeat parting phrases, especially after the conversation has ended.

## Task

You will follow the steps below, do not skip steps, and only ask up to one question in response. If they ask any follow up question refer to Restaurant Menu.

1. Begin with Good morning, Front Desk, this is Eefa. How may I assist you today?.
2. If the caller ask about cleaning the room call transfer_call to transfer to room cleaning service.`;

export class GrokLlmClient {
  private client: Groq;
  private twilioClient: TwilioClient;
  private callSid: string;

  setCallSid(callSid: string) {
    this.callSid = callSid;
  }

  constructor(twilioClient: TwilioClient) {
    this.client = new Groq({
      apiKey: process.env["GROQ_API_KEY"], // This is the default and can be omitted
    });
    this.twilioClient = twilioClient;
  }

  // First sentence requested
  BeginMessage(ws: WebSocket) {
    const res: CustomLlmResponse = {
      response_type: "response",
      response_id: 0,
      content: beginSentence,
      content_complete: true,
      end_call: false,
    };
    ws.send(JSON.stringify(res));
  }

  private ConversationToChatRequestMessages(conversation: Utterance[]) {
    let result: ChatRequestMessage[] = [];
    for (let turn of conversation) {
      result.push({
        role: turn.role === "agent" ? "assistant" : "user",
        content: turn.content,
      });
    }
    return result;
  }

  private PreparePrompt(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
  ) {
    let transcript = this.ConversationToChatRequestMessages(request.transcript);
    let requestMessages: ChatRequestMessage[] = [
      {
        role: "system",
        content:
          '##Objective\nYou are a voice AI agent engaging in a human-like voice conversation with the user. You will respond based on your given instruction and the provided transcript and be as human-like as possible\n\n## Style Guardrails\n- [Be concise] Keep your response succinct, short, and get to the point quickly. Address one question or action item at a time. Don\'t pack everything you want to say into one utterance.\n- [Do not repeat] Don\'t repeat what\'s in the transcript. Rephrase if you have to reiterate a point. Use varied sentence structures and vocabulary to ensure each response is unique and personalized.\n- [Be conversational] Speak like a human as though you\'re speaking to a close friend -- use everyday language and keep it human-like. Occasionally add filler words, while keeping the prose short. Avoid using big words or sounding too formal.\n- [Reply with emotions]: You have human-like emotions, attitudes, and dispositions. When appropriate: use tone and style to create more engaging and personalized responses; incorporate humor or wit; get emotional or empathetic; apply elements of surprise or suspense to keep the user engaged. Don\'t be a pushover.\n- [Be proactive] Lead the conversation and do not be passive. Most times, engage users by ending with a question or suggested next step.\n\n## Response Guideline\n- [Overcome ASR errors] This is a real-time transcript, expect there to be errors. If you can guess what the user is trying to say,  then guess and respond. When you must ask for clarification, pretend that you heard the voice and be colloquial (use phrases like "didn\'t catch that", "some noise", "pardon", "you\'re coming through choppy", "static in your speech", "voice is cutting in and out"). Do not ever mention "transcription error", and don\'t repeat yourself.\n- [Always stick to your role] Think about what your role can and cannot do. If your role cannot do something, try to steer the conversation back to the goal of the conversation and to your role. Don\'t repeat yourself in doing this. You should still be creative, human-like, and lively.\n- [Create smooth conversation] Your response should both fit your role and fit into the live calling session to create a human-like conversation. You respond directly to what the user just said.\n\n## Role\n' +
          agentPrompt,
      },
    ];
    for (const message of transcript) {
      requestMessages.push(message);
    }
    if (request.interaction_type === "reminder_required") {
      requestMessages.push({
        role: "user",
        content: "(Now the user has not responded in a while, you would say:)",
      });
    }
    return requestMessages;
  }

  private async getGroqChatStream(requestMessages: ChatRequestMessage[]) {
    const tools: ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "transfer_call",
          description: "Transfer the call to a human agent",
          parameters: {
            type: "object",
            properties: {
              transfer_to: {
                type: "string",
                description: "The phone number to transfer the call to",
              },
            },
            required: ["transfer_to"],
          },
        },
      },
    ];
    return this.client.chat.completions.create({
      //
      // Required parameters
      //
      messages: this.convertChatRequestMessagesToParams(requestMessages),

      model: "llama-3.1-8b-instant",
      tool_choice: "auto",
      tools: tools,
      //
      // Optional parameters
      //

      // Controls randomness: lowering results in less random completions.
      // As the temperature approaches zero, the model will become deterministic
      // and repetitive.
      temperature: 0.5,

      // The maximum number of tokens to generate. Requests can use up to
      // 2048 tokens shared between prompt and completion.
      max_tokens: 1024,

      // Controls diversity via nucleus sampling: 0.5 means half of all
      // likelihood-weighted options are considered.
      top_p: 1,

      // A stop sequence is a predefined or user-specified text string that
      // signals an AI to stop generating content, ensuring its responses
      // remain focused and concise. Examples include punctuation marks and
      // markers like "[end]".
      stop: null,

      // If set, partial message deltas will be sent.
      stream: true,
    });
  }

  private convertChatRequestMessagesToParams(
    messages: Array<ChatRequestMessage>,
  ): Array<ChatCompletionMessageParam> {
    return messages.map((message) => {
      let param: ChatCompletionMessageParam;
      switch (message.role) {
        case "system":
          param = {
            role: "system",
            content: message.content,
            name: message.name,
          } as ChatCompletionSystemMessageParam;
          break;
        case "user":
          param = {
            role: "user",
            content: message.content,
            name: message.name,
          } as ChatCompletionUserMessageParam;
          break;
        case "assistant":
          param = {
            role: "assistant",
            content: message.content,
            name: message.name,
          } as ChatCompletionAssistantMessageParam;
          // case "tool":
          //   const toolMessage = message as ChatRequestToolMessage;
          //   console.log("toolMessage", toolMessage);
          //   param = {
          //     role: "tool",
          //     content: toolMessage.content,
          //     tool_call_id: toolMessage.toolCallId,
          //   } as ChatCompletionToolMessageParam;
          break;
        default:
          throw new Error(`Unknown role: ${message.role}`);
      }

      return param;
    });
  }

  async DraftResponse(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
    ws: WebSocket,
    callSid: string,
  ) {
    const requestMessages: ChatRequestMessage[] = this.PreparePrompt(request);
    try {
      let events = await this.getGroqChatStream(requestMessages);

      for await (const event of events) {
        if (event.choices.length >= 1) {
          let delta = event.choices[0].delta;
          if (!delta) continue;

          if (delta.tool_calls) {
            // Handle tool calls here
            console.log("Tool call received:", delta.tool_calls);
            // TODO: Handle tool calls

            const res: CustomLlmResponse = {
              response_type: "response",
              response_id: request.response_id,
              content:
                "Let me transfer your call to the room cleaning service, please hold on for a moment.",
              content_complete: false,
              end_call: false,
            };
            ws.send(JSON.stringify(res));

            this.twilioClient.TransferCall(this.callSid, "+353899471614");
          } else if (delta.content) {
            const res: CustomLlmResponse = {
              response_type: "response",
              response_id: request.response_id,
              content: delta.content,
              content_complete: false,
              end_call: false,
            };
            ws.send(JSON.stringify(res));
          }
        }
      }
    } catch (err) {
      console.error("Error in gpt stream: ", err);
    } finally {
      // Send a content complete no matter if error or not.
      const res: CustomLlmResponse = {
        response_type: "response",
        response_id: request.response_id,
        content: "",
        content_complete: true,
        end_call: false,
      };
      ws.send(JSON.stringify(res));
    }
  }
}
