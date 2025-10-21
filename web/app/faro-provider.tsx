"use client";

import { useEffect } from "react";
import { faro, getWebInstrumentations, initializeFaro } from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";
import { ReactIntegration } from "@grafana/faro-react";

const DEFAULT_ENDPOINT = "/api/faro";

export default function FaroProvider() {
  useEffect(() => {
    if (faro.api) {
      return;
    }

    const endpoint = process.env.NEXT_PUBLIC_FARO_URL ?? DEFAULT_ENDPOINT;
    if (!endpoint) {
      console.warn("[faro] No endpoint configured (set NEXT_PUBLIC_FARO_URL or use default).");
      return;
    }

    const webInstrumentations = getWebInstrumentations({
      captureConsole: true,
      dom: true,
      webVitals: true,
    });

    try {
      const instance = initializeFaro({
        url: endpoint,
        app: {
          name: process.env.NEXT_PUBLIC_FARO_APP_NAME || "unknown_service:webjs",
          namespace: process.env.NEXT_PUBLIC_FARO_APP_NAMESPACE || undefined,
          version: process.env.VERCEL_DEPLOYMENT_ID || "1.0.0",
          environment: process.env.NEXT_PUBLIC_VERCEL_ENV || "development",
        },
        instrumentations: [
          ...webInstrumentations,
          new ReactIntegration(),
          new TracingInstrumentation(),
        ],
      });

      instance.api.pushLog(["faro_init", { ok: true, endpoint }]);
    } catch (error) {
      console.error("[faro] Failed to initialise", error);
    }
  }, []);

  return null;
}
