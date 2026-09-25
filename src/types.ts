export type EntityType =
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'SSN'
  | 'CREDIT_CARD'
  | 'DATE'
  | 'CURRENCY'
  | 'IP_ADDRESS'
  | 'IBAN'
  | 'ADDRESS'
  | 'COMPANY'
  | 'SECRET'
  | 'API_KEY'
  | 'OTHER';

export interface DetectedEntity {
  type: EntityType;
  value: string;
  start: number;
  end: number;
  confidence: number;
  detector: string;
}

export type ProgressCallback = (downloaded: number, total: number) => void;

/**
 * A detect call was cancelled through its AbortSignal (T222). Providers throw
 * it between chunks, the engine before and after the ML pass, and the worker
 * protocol client when the host acknowledges a `cancelDetect`.
 */
export class DetectionAbortedError extends Error {
  constructor(message: string = 'Detection aborted') {
    super(message);
    this.name = 'DetectionAbortedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Throw DetectionAbortedError when `signal` has been aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DetectionAbortedError();
}

/**
 * Interface for detection providers.
 * Implement this to add a new model/detection backend.
 * The engine only depends on this interface — swap providers without changing anything else.
 */
export interface DetectionProvider {
  /** Human-readable name for this provider */
  readonly name: string;

  /** Initialize/download the model. Called once on app load. */
  load(): Promise<void>;

  /** Whether the provider is ready to detect */
  isLoaded(): boolean;

  /** Whether the provider is currently loading */
  isLoading(): boolean;

  /** Register a callback for download progress updates */
  onProgress(callback: ProgressCallback): void;

  /**
   * Run detection on the given text. Optional progress callback (0-1).
   * `signal` (T222) is checked between inference chunks: an aborted signal
   * makes the provider stop at the next chunk boundary and reject with
   * DetectionAbortedError (work already done is discarded).
   */
  detect(text: string, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<DetectedEntity[]>;

  /** Set detection confidence threshold */
  setThreshold(value: number): void;

  /** Get current detection confidence threshold */
  getThreshold(): number;

  /** Release the ONNX session and free memory. Provider can be re-loaded later. */
  release(): void;
}

export interface ReplacementEntry {
  original: string;
  replacement: string;
  entityType: EntityType;
}


export const ENTITY_COLORS: Record<EntityType, string> = {
  PERSON: '#7B2FF7',
  EMAIL: '#2563EB',
  PHONE: '#0D9488',
  SSN: '#B45309',
  CREDIT_CARD: '#CA8A04',
  DATE: '#6D28D9',
  CURRENCY: '#EA580C',
  IP_ADDRESS: '#0284C7',
  IBAN: '#A16207',
  ADDRESS: '#DC2626',
  COMPANY: '#DB2777',
  SECRET: '#E11D48',
  API_KEY: '#059669',
  OTHER: '#6B7280',
};

export const ENTITY_LABELS: Record<EntityType, string> = {
  PERSON: 'Name',
  EMAIL: 'Email',
  PHONE: 'Phone',
  SSN: 'SSN',
  CREDIT_CARD: 'Credit Card',
  DATE: 'Date',
  CURRENCY: 'Currency',
  IP_ADDRESS: 'IP Address',
  IBAN: 'IBAN',
  ADDRESS: 'Address',
  COMPANY: 'Company',
  SECRET: 'Secret',
  API_KEY: 'API Key',
  OTHER: 'Other',
};
