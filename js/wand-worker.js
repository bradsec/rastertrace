import { coarseRegion, finishRegion } from "./wand-pipeline.js?v=5";

self.onmessage = ({ data }) => {
  const { id, phase, args } = data;
  try {
    if (phase === "coarse") {
      const result = coarseRegion(.../** @type {Parameters<typeof coarseRegion>} */ (args));
      self.postMessage({ id, result }, { transfer: result ? [result.mask.buffer] : [] });
    } else {
      self.postMessage({
        id,
        result: finishRegion(.../** @type {Parameters<typeof finishRegion>} */ (args)),
      });
    }
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
