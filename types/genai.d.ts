declare module "@google/genai" {
  export class GoogleGenAI {
    constructor(opts: { apiKey: string });
    models: {
      generateContent: (params: any) => Promise<any>;
    };
  }
}
