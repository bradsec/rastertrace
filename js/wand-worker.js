import { coarseRegion, finishRegion } from "./wand-pipeline.js?v=1";

self.onmessage = ({ data }) => {
  const { id, phase, args } = data;
  try {
    if (phase === "coarse") {
      const result = coarseRegion(...args);
      self.postMessage({ id, result }, { transfer: result ? [result.mask.buffer] : [] });
    } else {
      self.postMessage({ id, result: finishRegion(...args) });
    }
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
