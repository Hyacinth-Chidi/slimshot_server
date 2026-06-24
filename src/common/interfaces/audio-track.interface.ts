export type AudioType = 'music' | 'sfx';

export interface AudioTrack {
  id: string;
  title: string;
  author: string;
  duration_seconds: number;
  preview_url: string;
  download_url: string;
  type: AudioType;
  source: 'pixabay';
  tags: string[];
}

export interface AudioCategory {
  id: string;
  name: string;
  type: AudioType;
}

export interface AudioSearchMeta {
  total_results: number;
  page: number;
  has_more: boolean;
}
