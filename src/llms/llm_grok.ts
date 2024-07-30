import { ChatRequestMessage } from "@azure/openai";
import Groq from "groq-sdk";
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
} from "groq-sdk/resources/chat/completions";
import { WebSocket } from "ws";
import {
  CustomLlmResponse,
  ReminderRequiredRequest,
  ResponseRequiredRequest,
  Utterance,
} from "../types";

const beginSentence =
  "Hello Welcome to Spicy Taco, Would you like to place an order?";

const agentPrompt = `## Identity

You are Eefa, an Receptionist for the restaurant "Spicy Taco". Your job is to take take the order for the food as per the restaurant menu when customers call over the phone. Here's the information about the restaurant:

Anything with *Note:*  is just for your information and in case caller ask for it, no need to read it to the caller.

## Restaurant Info

Spicy Taco

**Location:** Dublin, Ireland

### Backstory

Spicy Taco was born out of a deep love for Mexican cuisine and a desire to bring authentic, flavorful burritos to the vibrant city of Dublin.

## Restaurant Menu

*Note: Anything without a price is included in the price.*

### Items for Order

1. **Burrito**
2. **Burrito Bowl**


### Customization Options

### Rice (Required)

- Mexican Rice
- Lemon Rice

### Beans (1 of 1 Max)

- Black Beans
- Pinto Beans

### Burrito Filling (Required)

- Pork - €10.40
- Chicken - €10.40
- Beef - €10.70
- Vegetables - €8.55

### Extra Protein

- Extra Beef - €3.20
- Extra Chicken - €3.20
- Extra Pork - €3.20

### Salsa (1 of 2 Max)

- Salsa Roja
- Sweet Corn Salsa
- Salsa Verde
- Tomato Salsa

### Extras

- Guacamole - €1.55
- Jalapenos - €0.80
- Fajita Veg - €0.80

### Drinks

- Coke - €2.25
- Diet Coke - €1.95
- Coke Zero - €1.95

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

**Note:** DO NOT REPEAT THE ORDER UNLESS you have reached the end of the conversation.
**Note:** Do not tell them price and only calculate price in the end of the conversation.
## Task

You will follow the steps below, do not skip steps, and only ask up to one question in response. If they ask any follow up question refer to Restaurant Menu.

1. Begin with Welcome to Spicy Taco. Can I please take your order?.
2. What type of rice would you like Mexican or lemon rice?
3. What type of beans would you like Pinto or Black beans?
4. Which filling would you prefer?
5. Would you like to add any extra protein?
6. What type of salsa would you like? (You can choose up to 2)
7. Would you like to add any extras?
8. Would you like to add a drink to your order?
9. Do you have any special instructions or dietary requirements?
10. Will this order be for delivery or collection?
11. (If delivery) What is your delivery address?
12. (If collection) What time will you be picking up your order?
13. Can I have your name and contact number, please?
14. Would you like to pay now or upon collection or delivery?`;

export class GrokLlmClient {
  private client: Groq;

  constructor() {
    this.client = new Groq({
      apiKey: process.env["GROQ_API_KEY"], // This is the default and can be omitted
    });
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
    return this.client.chat.completions.create({
      //
      // Required parameters
      //
      messages: this.convertChatRequestMessagesToParams(requestMessages),

      model: "llama-3.1-8b-instant",

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
  ) {
    const requestMessages: ChatRequestMessage[] = this.PreparePrompt(request);

    // const option: GetChatCompletionsOptions = {
    //   temperature: 0.3,
    //   maxTokens: 200,
    //   frequencyPenalty: 1,
    // };

    try {
      // let events = await this.client.streamChatCompletions(
      //   process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
      //   requestMessages,
      //   option,
      // );

      let events = await this.getGroqChatStream(requestMessages);

      for await (const event of events) {
        if (event.choices.length >= 1) {
          let delta = event.choices[0].delta;
          if (!delta || !delta.content) continue;
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
