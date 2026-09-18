/**
 * Stands in for `onnxruntime-web` in the Lambda bundle.
 *
 * transformers.js imports both ONNX runtimes and picks one at load: in Node it uses
 * `onnxruntime-node` and never touches the web runtime. Stubbing it keeps the WebAssembly
 * build and its multi-megabyte .wasm files out of the deployment package.
 */
export default {};
