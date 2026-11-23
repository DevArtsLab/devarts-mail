// Vitest stub for the Workers-only `cloudflare:email` module.
export class EmailMessage {
  constructor(
    public from: string,
    public to: string,
    public raw: string,
  ) {}
}
