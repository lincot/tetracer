const chalk: any = new Proxy((text: string) => text, { get: () => chalk });

export default chalk;
