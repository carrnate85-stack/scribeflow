/// <reference lib="webworker" />

import { env, pipeline } from "@huggingface/transformers";

type WhisperRequest =
  | { type: "load" }
  | {
      type: "transcribe";
      id: number;
      session: number;
      audio: ArrayBuffer;
    };

type WhisperResult = {
  text?: string;
};

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const localModelId = "whisper-large-v3-ONNX";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = "http://127.0.0.1:3001/models/";
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = "/wasm/";

let transcriberPromise: ReturnType<typeof pipeline> | null = null;
let transcriptionQueue = Promise.resolve();

function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline(
      "automatic-speech-recognition",
      localModelId,
      {
        device: "webgpu",
        dtype: {
          encoder_model: "q4f16",
          decoder_model_merged: "q4f16",
        },
        progress_callback: (progress: {
          status?: string;
          progress?: number;
          file?: string;
        }) => {
          workerScope.postMessage({
            type: "progress",
            status: progress.status,
            progress: progress.progress,
            file: progress.file,
          });
        },
      },
    );
  }
  return transcriberPromise;
}

async function loadModel() {
  await getTranscriber();
  workerScope.postMessage({ type: "ready" });
}

async function transcribe(
  request: Extract<WhisperRequest, { type: "transcribe" }>,
) {
  const audio = new Float32Array(request.audio);
  try {
    const transcriber = await getTranscriber();
    const result = (await transcriber(audio, {
      return_timestamps: false,
      language: "english",
      task: "transcribe",
      num_beams: 5,
      do_sample: false,
    })) as WhisperResult;
    workerScope.postMessage({
      type: "result",
      id: request.id,
      session: request.session,
      text: String(result.text || "").trim(),
    });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      id: request.id,
      session: request.session,
      message:
        error instanceof Error
          ? error.message
          : "Local Whisper could not transcribe this audio",
    });
  } finally {
    audio.fill(0);
  }
}

workerScope.onmessage = (event: MessageEvent<WhisperRequest>) => {
  const request = event.data;
  if (request.type === "load") {
    void loadModel().catch((error) => {
      workerScope.postMessage({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "The local Whisper model could not load",
      });
    });
    return;
  }

  transcriptionQueue = transcriptionQueue.then(() => transcribe(request));
};
