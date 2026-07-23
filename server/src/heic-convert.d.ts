declare module 'heic-convert' {
  interface Options {
    buffer: Buffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }
  function heicConvert(options: Options): Promise<Buffer>;
  export = heicConvert;
}
