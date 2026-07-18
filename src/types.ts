export type Props = {
  userId: string;
  displayName: string;
  email: string;
} & Record<string, unknown>;

export type TokenRecord = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
};

export type GraphDriveItem = {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  file?: {
    mimeType?: string;
    hashes?: { quickXorHash?: string; sha1Hash?: string; sha256Hash?: string };
  };
  folder?: { childCount?: number };
  package?: Record<string, unknown>;
  image?: { width?: number; height?: number };
  photo?: { orientation?: number };
  parentReference?: {
    path?: string;
    driveId?: string;
    id?: string;
  };
  remoteItem?: GraphDriveItem;
  deleted?: Record<string, unknown>;
};

export type GraphCollection<T> = {
  value: T[];
  "@odata.nextLink"?: string;
};

export type MicrosoftProfile = {
  id: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string | null;
};

export type CompactItem = {
  itemId: string;
  filename: string;
  relativePath: string;
  type: "file" | "folder";
  mimeType: string | null;
  extension: string;
  byteSize: number | null;
  modifiedDate: string | null;
  eTag: string | null;
};

export type VisualAsset = CompactItem & {
  width: number | null;
  height: number | null;
  orientation: "landscape" | "portrait" | "square" | "unknown";
  directlyAnalysable: boolean;
  conversionRequired: boolean;
  originalFetchAvailable: boolean;
};

export type ImageMetadata = VisualAsset & {
  animated: boolean | null;
  pageCount: number | null;
  exifOrientationCorrectionNeeded: boolean;
  convertedPreviewAvailable: boolean;
};
