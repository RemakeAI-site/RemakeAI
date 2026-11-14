export interface StudioSettings {
  name: string;
  logo_media_id: string | null;
  accent: string;
  theme: "dark" | "light" | "system";
  density: "comfortable" | "compact";
  text_limit: number;
  archive_limit: number;
  trash_days: number;
  timezone: string;
  date_format: string;
  storage_limit: number;
  storage_warn: number;
  indicator_basis: "ready" | "unpublished" | "all" | "published";
  red_max: number;
  yellow_max: number;
  green_min: number;
  red_color: string;
  yellow_color: string;
  green_color: string;
}

export interface Publication {
  id: string;
  title: string;
  category_id: string | null;
  cover_media_id: string | null;
  preview_media_id?: string | null;
  status_id: string;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  tiktok_url: string | null;
  version: number;
}

export interface Category {
  id: string;
  name: string;
  path?: string | string[];
  color?: string;
  parent_id?: string | null;
  indicator_label?: string;
  indicator_color?: string;
}

export interface Status {
  id: string;
  name: string;
  color: string;
  sort_order: number;
}

export interface PageData<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface BackupRecord {
  id: string;
  created_at: string;
  status: string;
  object_count: number;
  detail?: string | null;
}

export interface TrashItem {
  id: string;
  type: "category" | "publication" | "idea" | "attachment" | "cover";
  name: string;
  deleted_at: string;
  group?: string | null;
  owner_type?: string | null;
}

export interface DiagnosticsCheck {
  ok?: boolean;
  time?: number;
  message?: string;
  error?: string;
}

export interface SystemData {
  database: boolean | string | DiagnosticsCheck;
  storage: boolean | string | DiagnosticsCheck;
  version: string;
  usage: { originals: number; previews: number; images: number; videos: number; trash: number; count: number };
  categories: Array<{ id: string; name: string; bytes: number }>;
  largest: Array<{ id: string; title: string; bytes: number }>;
  backup: BackupRecord | null;
  errors: Array<string | { id?: string; error?: string; message?: string; detail?: string; created_at?: string }>;
}
