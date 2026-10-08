/** Invalid caller input, distinct from retailer or transport failures. */
export class ProviderInputError extends Error {
  readonly provider: string;
  constructor(provider: string, message: string) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderInputError';
    this.provider = provider;
  }
}
