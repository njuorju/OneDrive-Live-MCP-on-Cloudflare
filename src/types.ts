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
  webUrl?: string;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: {
    path?: string;
    driveId?: string;
    id?: string;
  };
  remoteItem?: GraphDriveItem & {
    parentReference?: {
      path?: string;
      driveId?: string;
      id?: string;
    };
  };
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
