
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

export const listTemplates = async (token: string): Promise<DriveFile[]> => {
  const response = await fetch('https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&fields=files(id,name,mimeType)', {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) throw new Error('Failed to list templates');
  const data = await response.json();
  return data.files || [];
};

export const searchTemplate = async (token: string, name: string): Promise<DriveFile | null> => {
  const query = encodeURIComponent(`name contains '${name}' and mimeType = 'application/vnd.google-apps.document'`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType)&pageSize=1`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.files?.[0] || null;
};

export const uploadToDrive = async (token: string, blob: Blob, fileName: string) => {
  const metadata = {
    name: fileName,
    mimeType: blob.type
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    },
    body: form
  });

  if (!response.ok) throw new Error('Failed to upload to Drive');
  return await response.json();
};
