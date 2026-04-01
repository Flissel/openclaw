/**
 * Ollama Embedding Client
 *
 * Uses OpenAI-compatible API served by Ollama at /v1/embeddings.
 * Default model: nomic-embed-text (768 dimensions).
 */

import OpenAI from "openai";

export class EmbeddingClient {
  private client: OpenAI;

  constructor(
    private readonly model: string,
    baseUrl: string,
    private readonly dimensions?: number,
  ) {
    // Ollama serves OpenAI-compatible API; no real API key needed
    this.client = new OpenAI({ apiKey: "ollama", baseURL: `${baseUrl}/v1` });
  }

  async embed(text: string): Promise<number[]> {
    const params: { model: string; input: string; dimensions?: number } = {
      model: this.model,
      input: text,
    };
    if (this.dimensions) {
      params.dimensions = this.dimensions;
    }
    const response = await this.client.embeddings.create(params);
    return response.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Ollama supports batch embedding via array input
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return response.data.map((d) => d.embedding);
  }
}
