/**
 * Stands in for `sharp` in the Lambda bundle.
 *
 * transformers.js imports sharp at load time for image pipelines, and throws "Unable to
 * load image processing library" if the import is falsy — so this must be a truthy value,
 * not an empty module. Text embedding never calls it. Leaving the real package out avoids
 * its native libvips install, which npm blocks here and which would need a Linux build.
 */
export default function sharp(): never {
  throw new Error('Image processing is not available in the API bundle.');
}
