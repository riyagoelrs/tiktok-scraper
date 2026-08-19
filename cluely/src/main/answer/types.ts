export interface GenerateRequest {
  system: string;
  user: string;
  /** Base64 PNG of the screen, when the question is about what's on it. */
  image?: string;
  maxTokens: number;
  signal: AbortSignal;
  /** Called with each token as it arrives. */
  onDelta(text: string): void;
}

export interface AnswerProvider {
  readonly name: string;
  /**
   * Streams an answer, resolving when the model is done. Throws an Error whose
   * message is already fit to show the user — providers know their own failure
   * modes better than the caller does.
   */
  generate(request: GenerateRequest): Promise<void>;
}
