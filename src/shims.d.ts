declare module 'rhino3dm/rhino3dm.module.js' {
  const factory: (opts?: unknown) => Promise<any>;
  export default factory;
}
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
