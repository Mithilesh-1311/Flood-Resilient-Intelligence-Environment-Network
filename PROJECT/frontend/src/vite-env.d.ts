/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public HTTPS origin of the FRiEND controller. Unset in local dev. */
  readonly VITE_CONTROLLER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
