export type ScreenName = 'login' | 'list' | 'report';

export interface BlockTableMeta {
  quv?: boolean;
  times?: number[];
}

export interface BlockMeta {
  label: string;
  slot: string;
  always?: boolean;
  fields: [string, string][];
  table?: BlockTableMeta;
}

export interface AppMeta {
  order: string[];
  blocks: Record<string, BlockMeta>;
}

export interface ReportListRow {
  reportNo: string;
  buyer?: string;
  factory?: string;
  color?: string;
  request?: string;
  completed?: boolean | string;
  saved?: boolean;
}

export interface LabReading {
  L: string;
  a: string;
  b: string;
}

export interface LabTableData {
  times: number[];
  base: LabReading;
  rows: LabReading[];
}

export interface SavedResults {
  size: string;
  blocks: string[];
  values: Record<string, string>;
  tables: Record<string, LabTableData>;
}

export interface ReportSuggest {
  blocks?: string[];
  yelHrs?: string | number;
  waterHrs?: string | number;
  heatHrs?: string | number;
  xrite?: boolean;
  warnings?: string[];
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArrowAnnotation {
  type: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  double: boolean;
}

export interface TextAnnotation {
  type: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  rotate: 0 | 90 | -90;
  outline: boolean;
}

export type PhotoAnnotation = ArrowAnnotation | TextAnnotation;

export interface PhotoParams {
  rotate: number; // 0 | 90 | 180 | 270
  crop: CropRect;
  sharpness: number; // 0..100
  temperature: number; // -100..100
  annotations?: PhotoAnnotation[];
}

export interface PhotoItem {
  id: string;
  slot: string;
  order: number;
  params?: PhotoParams | string | null;
  // Client-only transient states
  uploading?: boolean;
  localPreviewUrl?: string;
}

export interface BaseApiResponse {
  status: 'success' | 'error';
  message?: string;
  needLogin?: boolean;
}

export interface ReportGetResponse extends BaseApiResponse {
  data?: Record<string, unknown>;
  general?: Record<string, unknown>;
  suggest?: ReportSuggest;
  results?: SavedResults | null;
  photos?: PhotoItem[];
}

export interface LoginResponse extends BaseApiResponse {
  meta?: AppMeta;
}

export interface RequestTokenResponse extends BaseApiResponse {}

export interface VerifyTokenResponse extends BaseApiResponse {
  session?: string;
  meta?: AppMeta;
}

export interface ListResponse extends BaseApiResponse {
  rows?: ReportListRow[];
}

export interface SaveResultsResponse extends BaseApiResponse {}

export interface SavePhotoResponse extends BaseApiResponse {
  photoId?: string;
}

export interface BasicResponse extends BaseApiResponse {}

export interface GetPhotoResponse extends BaseApiResponse {
  data?: string;
  mime?: string;
}

export interface BuildReportResponse extends BaseApiResponse {
  fileName?: string;
  mime?: string;
  data?: string;
}
