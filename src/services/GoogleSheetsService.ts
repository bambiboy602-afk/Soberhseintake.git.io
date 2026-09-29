
export const searchSheet = async (token: string, name: string): Promise<string | null> => {
  const query = encodeURIComponent(`name contains '${name}' and mimeType = 'application/vnd.google-apps.spreadsheet'`);
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType)&pageSize=1`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.files?.[0]?.id || null;
};

export const createComplianceSheet = async (token: string, name: string): Promise<string> => {
  const metadata = {
    name: name,
    mimeType: 'application/vnd.google-apps.spreadsheet'
  };

  const response = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(metadata)
  });

  if (!response.ok) throw new Error('Failed to create sheet');
  const file = await response.json();
  
  // Initialize headers
  const headers = [
    ['Full Name', 'DOB', 'Email', 'Insurance', 'Policy ID', 'Emergency Contact', 'Status', 'App Date', 'TB Verified', 'Presence Verified', 'Naloxone Attested', 'Storage Ack']
  ];
  
  await appendRow(token, file.id, headers);
  
  return file.id;
};

export const appendRow = async (token: string, spreadsheetId: string, values: any[][]) => {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      values: values
    })
  });

  if (!response.ok) {
    const error = await response.json();
    console.error('Sheets Error:', error);
    throw new Error('Failed to append row to sheet');
  }
  return await response.json();
};
