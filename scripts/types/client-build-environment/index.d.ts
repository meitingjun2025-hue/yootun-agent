/** Build-time values that bundlers replace before client code reaches a browser. */
declare const process: {
  readonly env: {
    readonly NODE_ENV?: string
    readonly [name: `DSH_CLIENT_${string}`]: string | undefined
    /** yootun enterprise tier (registered inline change): brand values inlined by the
        client bundler define (packages/client/tsdown.client.ts); official builds leave
        them undefined so consumers fall back to the official copy. */
    readonly [name: `YOOTUN_BRAND_${string}`]: string | undefined
  }
}
