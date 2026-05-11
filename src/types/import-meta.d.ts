interface ImportMeta {
  glob<Module = Record<string, unknown>>(
    pattern: string,
    options?: { eager?: boolean },
  ): Record<string, Module>
}

declare module '@mrgnlabs/marginfi-client-v2' {
  export const MARGINFI_IDL: unknown
}
