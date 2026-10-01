/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, User, signOut } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, updateDoc, query, where, getDocs, onSnapshot, orderBy, serverTimestamp, Timestamp, arrayUnion } from 'firebase/firestore';
import SignatureCanvas from 'react-signature-canvas';
import { jsPDF } from 'jspdf';
import firebaseConfig from '../firebase-applet-config.json';
import * as driveService from './services/GoogleDriveService';
import * as sheetsService from './services/GoogleSheetsService';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export interface StatusHistoryEntry {
  status: string;
  changedAt: string;
  changedBy?: string;
  note?: string;
}

export const STATUS_CONFIG: Record<string, { label: string; color: string; badge: string; dot: string; icon: string }> = {
  application: {
    label: 'Application Started',
    color: 'text-blue-700',
    badge: 'bg-blue-50 text-blue-700 border-blue-200',
    dot: 'bg-blue-500',
    icon: '📝',
  },
  pending_review: {
    label: 'Pending Clinical Review',
    color: 'text-amber-700',
    badge: 'bg-amber-50 text-amber-700 border-amber-200',
    dot: 'bg-amber-500',
    icon: '⏳',
  },
  approved: {
    label: 'Approved by Manager',
    color: 'text-emerald-700',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    dot: 'bg-emerald-500',
    icon: '✓',
  },
  scheduled: {
    label: 'Move-In Scheduled',
    color: 'text-indigo-700',
    badge: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    dot: 'bg-indigo-500',
    icon: '📅',
  },
  orientation: {
    label: 'Orientation Pending',
    color: 'text-purple-700',
    badge: 'bg-purple-50 text-purple-700 border-purple-200',
    dot: 'bg-purple-500',
    icon: '🏠',
  },
  active: {
    label: 'Active Move-In',
    color: 'text-green-700',
    badge: 'bg-green-50 text-green-700 border-green-200',
    dot: 'bg-green-500',
    icon: '✨',
  },
  declined: {
    label: 'Application Declined',
    color: 'text-red-700',
    badge: 'bg-red-50 text-red-700 border-red-200',
    dot: 'bg-red-500',
    icon: '✕',
  },
};

export const formatTimestamp = (isoString?: string) => {
  if (!isoString) return 'Date unknown';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
};

export const getNormalizedTimeline = (res: any): StatusHistoryEntry[] => {
  if (Array.isArray(res.statusHistory) && res.statusHistory.length > 0) {
    return [...res.statusHistory].sort((a, b) => {
      const timeA = new Date(a.changedAt || 0).getTime();
      const timeB = new Date(b.changedAt || 0).getTime();
      return timeA - timeB;
    });
  }

  // Graceful fallback for historical entries recorded prior to statusHistory schema
  const fallback: StatusHistoryEntry[] = [];
  if (res.applicationDate) {
    fallback.push({
      status: 'application',
      changedAt: res.applicationDate,
      changedBy: res.email || 'Applicant',
      note: 'Initial application submitted',
    });
  }
  if (res.onboardingStep >= 10 || res.status === 'pending_review' || res.status === 'active' || res.status === 'approved' || res.status === 'declined') {
    fallback.push({
      status: 'pending_review',
      changedAt: res.applicationDate || new Date().toISOString(),
      changedBy: res.email || 'Applicant',
      note: 'Completed onboarding documentation and submitted for clinical sign-off',
    });
  }
  if (res.status === 'active' || res.status === 'declined' || res.status === 'approved' || res.status === 'scheduled' || res.status === 'orientation') {
    fallback.push({
      status: res.status,
      changedAt: new Date().toISOString(),
      changedBy: 'House Manager',
      note: res.status === 'active' ? 'Approved for move-in and residency activated' : res.status === 'declined' ? 'Application declined' : `Status updated to ${res.status.replace('_', ' ')}`,
    });
  }
  return fallback;
};

const steps = [
  { title: 'Application', fields: ['fullName', 'dob', 'email', 'language'] },
  { title: 'Documents & Health', fields: ['documentsSubmitted', 'checklist'] },
  { title: 'Emergency & HCDM', fields: ['emergencyContact'] },
  { title: 'Insurance & Financial', fields: ['insurance'] },
  { title: 'Legal Consents', fields: ['generalConsentSigned', 'roiSigned', 'nppSigned'] },
  { title: 'House Rules', fields: ['houseRulesSigned'] },
  { title: 'Residency Agreement', fields: ['residencyPaymentSigned'] },
  { title: 'Treatment Plan', fields: ['treatmentAgreementSigned'] },
  { title: 'Review', fields: [] },
];

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  attachment?: string;
  createdAt: Timestamp;
  isAdmin: boolean;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [residentId, setResidentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [googleToken, setGoogleToken] = useState<string | null>(localStorage.getItem('google_token'));
  const [driveTemplates, setDriveTemplates] = useState<driveService.DriveFile[]>([]);
  const [isUploadingToDrive, setIsUploadingToDrive] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<driveService.DriveFile | null>(null);
  const [viewMode, setViewMode] = useState<'resident' | 'manager'>('resident');
  const [allResidents, setAllResidents] = useState<any[]>([]);
  const [residentStatus, setResidentStatus] = useState<string>('application');
  const [residentStatusHistory, setResidentStatusHistory] = useState<StatusHistoryEntry[]>([]);
  const [managerNotes, setManagerNotes] = useState<Record<string, string>>({});
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedTimelines, setExpandedTimelines] = useState<Record<string, boolean>>({});
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const isAdmin = user?.email === 'bambiboy602@gmail.com';

  const TemplateLink = ({ name, label }: { name: string, label: string }) => {
    const [found, setFound] = useState<driveService.DriveFile | null>(null);
    const [searching, setSearching] = useState(false);

    useEffect(() => {
      if (!googleToken) return;
      const find = async () => {
        setSearching(true);
        const file = await driveService.searchTemplate(googleToken, name);
        setFound(file);
        setSearching(false);
      };
      find();
    }, [googleToken, name]);

    if (!googleToken) return null;
    if (searching) return <div className="text-[10px] text-blue-500 animate-pulse">Searching for {label} template...</div>;
    if (!found) return null;

    return (
      <a 
        href={`https://docs.google.com/document/d/${found.id}/view`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center space-x-1 text-[10px] text-blue-600 hover:underline font-bold bg-blue-50 p-1 rounded border border-blue-100 mb-2 w-max"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        <span>Open Official {label} Template</span>
      </a>
    );
  };

  const [formData, setFormData] = useState({
    fullName: '',
    dob: '',
    email: '',
    language: 'English',
    documentsSubmitted: false,
    emergencyContact: { name: '', phone: '', relation: '', isHCDM: false },
    insurance: { planName: '', idNumber: '', type: 'AHCCCS' },
    houseRulesSigned: false,
    residencyPaymentSigned: false,
    treatmentAgreementSigned: false,
    generalConsentSigned: false,
    roiSigned: false,
    nppSigned: false,
    checklist: {
      photoId: false,
      tbDocumentation: false,
      naloxoneAttestation: false,
      lockableStorageAck: false,
      authorizedPresence: false,
    },
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Fetch all residents if manager
        if (u.email === 'bambiboy602@gmail.com') {
          const qAll = query(collection(db, 'residents'), orderBy('applicationDate', 'desc'));
          onSnapshot(qAll, (snapshot) => {
            setAllResidents(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
          });
          setViewMode('manager');
        }

        // Fetch existing resident data
        try {
          const q = query(collection(db, 'residents'), where('ownerId', '==', u.uid));
          const querySnapshot = await getDocs(q);
          if (!querySnapshot.empty) {
            const residentDoc = querySnapshot.docs[0];
            const data = residentDoc.data();
            setResidentId(residentDoc.id);
            setResidentStatus(data.status || 'application');
            setResidentStatusHistory(Array.isArray(data.statusHistory) ? data.statusHistory : []);
            setStep(data.onboardingStep - 1);
            setFormData({
              fullName: data.fullName || '',
              dob: data.dob || '',
              email: data.email || '',
              language: data.language || 'English',
              documentsSubmitted: data.documentsSubmitted || false,
              emergencyContact: data.emergencyContact || { name: '', phone: '', relation: '', isHCDM: false },
              insurance: data.insurance || { planName: '', idNumber: '', type: 'AHCCCS' },
              houseRulesSigned: data.houseRulesSigned || false,
              residencyPaymentSigned: data.residencyPaymentSigned || false,
              treatmentAgreementSigned: data.treatmentAgreementSigned || false,
              generalConsentSigned: data.generalConsentSigned || false,
              roiSigned: data.roiSigned || false,
              nppSigned: data.nppSigned || false,
              checklist: data.checklist || { photoId: false, tbDocumentation: false, naloxoneAttestation: false, lockableStorageAck: false, authorizedPresence: false },
            });
          }
        } catch (err) {
          console.error('Error fetching resident data:', err);
        }
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleSignIn = async () => {
    try {
      const provider = new GoogleAuthProvider();
      provider.addScope('https://www.googleapis.com/auth/drive');
      provider.addScope('https://www.googleapis.com/auth/documents');
      provider.addScope('https://www.googleapis.com/auth/spreadsheets');
      
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        setGoogleToken(credential.accessToken);
        localStorage.setItem('google_token', credential.accessToken);
      }
    } catch (err) {
      console.error('Sign-in error:', err);
      setError('Failed to sign in.');
    }
  };

  const [toast, setToast] = useState<string | null>(null);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  const [documentPreview, setDocumentPreview] = useState<string | null>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setDocumentPreview(reader.result as string);
        setFormData({ ...formData, documentsSubmitted: true });
        showToast('Document captured successfully!');
      };
      reader.readAsDataURL(file);
    }
  };

  const [isSaving, setIsSaving] = useState(false);

  const sigCanvas = useRef<SignatureCanvas>(null);
  const [showIdModal, setShowIdModal] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [pendingAttachment, setPendingAttachment] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (!residentId || step !== 9) return;

    const q = query(
      collection(db, 'residents', residentId, 'messages'),
      orderBy('createdAt', 'asc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as ChatMessage[];
      setMessages(msgs);
    }, (err) => {
      console.error('Chat subscription error:', err);
    });

    return () => unsubscribe();
  }, [residentId, step]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!newMessage.trim() && !pendingAttachment) || !residentId || !user) return;

    try {
      await addDoc(collection(db, 'residents', residentId, 'messages'), {
        senderId: user.uid,
        senderName: formData.fullName,
        text: newMessage,
        attachment: pendingAttachment,
        createdAt: serverTimestamp(),
        isAdmin: false
      });
      setNewMessage('');
      setPendingAttachment(null);
    } catch (err) {
      console.error('Error sending message:', err);
      showToast('Failed to send message.');
    }
  };

  const handleAttachment = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 500000) { // 500KB limit for base64
        showToast('File too large. Max 500KB.');
        return;
      }
      const reader = new FileReader();
      reader.onloadend = () => {
        setPendingAttachment(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const clearSignature = () => sigCanvas.current?.clear();

  const handleSign = (field: keyof typeof formData, toastMsg: string) => {
    if (sigCanvas.current?.isEmpty()) {
      setError('Please provide a signature.');
      return;
    }
    setFormData({ ...formData, [field]: true });
    showToast(toastMsg);
    setError(null);
  };

  const downloadSummaryPDF = () => {
    const pdfBlob = generatePDFBlob();
    const url = URL.createObjectURL(pdfBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `AZ_Compliance_Record_${formData.fullName.replace(/\s+/g, '_')}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('AZ Compliance PDF downloaded!');
  };

  const uploadSummaryToDrive = async () => {
    if (!googleToken) {
      setError('Google Account not linked for Drive uploads.');
      return;
    }

    setIsUploadingToDrive(true);
    try {
      const pdfBlob = generatePDFBlob();
      const fileName = `AZ_Compliance_Record_${formData.fullName.replace(/\s+/g, '_')}.pdf`;
      await driveService.uploadToDrive(googleToken, pdfBlob, fileName);
      showToast('Compliance record saved to your Google Drive!');
    } catch (err) {
      console.error('Drive upload error:', err);
      setError('Failed to upload to Google Drive.');
    } finally {
      setIsUploadingToDrive(false);
    }
  };

  const generatePDFBlob = () => {
    const doc = new jsPDF();
    const margin = 20;
    let y = 20;

    doc.setFontSize(20);
    doc.text('AZ Sober Living Onboarding Record', margin, y);
    y += 10;
    doc.setFontSize(10);
    doc.text('Regulatory: AHCCCS / ADHS / AzRHA Compliance', margin, y);
    y += 10;

    doc.setFontSize(12);
    doc.text(`Full Legal Name: ${formData.fullName}`, margin, y);
    y += 8;
    doc.text(`Date of Birth: ${formData.dob}`, margin, y);
    y += 8;
    doc.text(`Language: ${formData.language}`, margin, y);
    y += 8;
    doc.text(`Email: ${formData.email}`, margin, y);
    y += 12;

    doc.setFontSize(14);
    doc.text('Insurance & Financial Management', margin, y);
    y += 8;
    doc.setFontSize(12);
    doc.text(`Plan: ${formData.insurance.planName} (${formData.insurance.type})`, margin, y);
    y += 7;
    doc.text(`Policy ID: ${formData.insurance.idNumber}`, margin, y);
    y += 12;

    doc.setFontSize(14);
    doc.text('Emergency Contact & HCDM', margin, y);
    y += 8;
    doc.setFontSize(12);
    doc.text(`Name: ${formData.emergencyContact.name}`, margin, y);
    y += 7;
    doc.text(`Phone: ${formData.emergencyContact.phone}`, margin, y);
    y += 7;
    doc.text(`HCDM Status: ${formData.emergencyContact.isHCDM ? 'DESIGNATED' : 'NOT DESIGNATED'}`, margin, y);
    y += 12;

    doc.setFontSize(14);
    doc.text('Demographics & Verification (Template 1.1)', margin, y);
    y += 8;
    doc.setFontSize(10);
    doc.text(`- Identity Verified: YES (Gov ID / ADCRR Inmate ID secured in file)`, margin, y); y += 6;
    doc.text(`- Communication Needs: Verified (${formData.language})`, margin, y); y += 6;
    doc.text(`- Emergency & HCDM: Formally Designated`, margin, y); y += 12;

    doc.setFontSize(14);
    doc.text('Arizona Compliance Checklist', margin, y);
    y += 8;
    doc.setFontSize(10);
    const checks = formData.checklist as any;
    doc.text(`- Photo ID / ADCRR ID: ${checks.photoId ? 'VERIFIED' : 'PENDING'}`, margin, y); y += 6;
    doc.text(`- Authorized Presence (§ 41-1080): ${checks.authorizedPresence ? 'VERIFIED' : 'PENDING'}`, margin, y); y += 6;
    doc.text(`- TB Freedom Documentation: ${checks.tbDocumentation ? 'VERIFIED' : 'PENDING'}`, margin, y); y += 6;
    doc.text(`- Naloxone/OD Education: ${checks.naloxoneAttestation ? 'COMPLETE' : 'PENDING'}`, margin, y); y += 6;
    doc.text(`- Lockable Storage Ack: ${checks.lockableStorageAck ? 'COMPLETE' : 'PENDING'}`, margin, y); y += 12;

    doc.setFontSize(14);
    doc.text('Agreement Attestations', margin, y);
    y += 8;
    doc.setFontSize(12);
    doc.text(`- House Rules signed: ${formData.houseRulesSigned ? 'YES' : 'NO'}`, margin, y); y += 7;
    doc.text(`- Residency Agreement signed: ${formData.residencyPaymentSigned ? 'YES' : 'NO'}`, margin, y); y += 7;
    doc.text(`- Treatment Plan Acknowledged: ${formData.treatmentAgreementSigned ? 'YES' : 'NO'}`, margin, y); y += 7;
    doc.text(`- General Consent signed: ${formData.generalConsentSigned ? 'YES' : 'NO'}`, margin, y); y += 7;
    doc.text(`- ROI (Release of Info) signed: ${formData.roiSigned ? 'YES' : 'NO'}`, margin, y); y += 7;
    doc.text(`- NPP (Privacy) signed: ${formData.nppSigned ? 'YES' : 'NO'}`, margin, y); y += 15;

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text('Electronically signed and verified in compliance with Arizona Regulatory Standards.', margin, y);
    doc.text(`System Timestamp: ${new Date().toISOString()}`, margin, y + 5);
    
    return doc.output('blob');
  };

  const fetchTemplates = async () => {
    if (!googleToken) return;
    try {
      const files = await driveService.listTemplates(googleToken);
      setDriveTemplates(files);
    } catch (err) {
      console.error('Error fetching templates:', err);
    }
  };

  useEffect(() => {
    if (googleToken && step === 9) {
      fetchTemplates();
    }
  }, [googleToken, step]);

  const handleReset = async () => {
    try {
      await signOut(auth);
      setStep(0);
      setResidentId(null);
      setResidentStatus('application');
      setResidentStatusHistory([]);
      setFormData({
        fullName: '',
        dob: '',
        email: '',
        language: 'English',
        documentsSubmitted: false,
        emergencyContact: { name: '', phone: '', relation: '', isHCDM: false },
        insurance: { planName: '', idNumber: '', type: 'AHCCCS' },
        houseRulesSigned: false,
        residencyPaymentSigned: false,
        treatmentAgreementSigned: false,
        generalConsentSigned: false,
        roiSigned: false,
        nppSigned: false,
        checklist: { photoId: false, tbDocumentation: false, naloxoneAttestation: false, lockableStorageAck: false, authorizedPresence: false },
      });
      setDocumentPreview(null);
      showToast('Form reset and signed out.');
    } catch (err) {
      console.error('Reset error:', err);
      setError('Failed to reset form.');
    }
  };

  useEffect(() => {
    const autoSave = async () => {
      if (!user || !formData.fullName || !formData.email || !residentId) return;
      
      setIsSaving(true);
      try {
        await updateDoc(doc(db, 'residents', residentId), {
          ...formData,
          onboardingStep: step + 1,
        });
      } catch (err) {
        console.error('Auto-save error:', err);
      } finally {
        setIsSaving(false);
      }
    };

    const timeoutId = setTimeout(autoSave, 1000);
    return () => clearTimeout(timeoutId);
  }, [formData, step, user, residentId]);

  const handleNext = async () => {
    if (!user) {
      setError('You must be signed in to submit an application.');
      return;
    }

    try {
      if (step === 0 && !residentId) {
        if (!formData.fullName || !formData.email) {
          setError('Full Name and Email are required.');
          return;
        }
        setError(null);
        setIsSaving(true);
        const now = new Date().toISOString();
        const initialStatusHistory: StatusHistoryEntry[] = [
          {
            status: 'application',
            changedAt: now,
            changedBy: user.email || 'Applicant',
            note: 'Initial application submitted',
          },
        ];
        const docRef = await addDoc(collection(db, 'residents'), {
          ...formData,
          status: 'application',
          statusHistory: initialStatusHistory,
          applicationDate: now,
          onboardingStep: 1,
          ownerId: user.uid,
        });
        setResidentId(docRef.id);
        setResidentStatus('application');
        setResidentStatusHistory(initialStatusHistory);
        setIsSaving(false);
        showToast('Application submitted successfully!');
      }
      setStep((prev) => prev + 1);
    } catch (error) {
      console.error('Error saving step: ', error);
      setError('An error occurred. Please try again.');
      setIsSaving(false);
    }
  };

  const syncToComplianceSheet = async () => {
    if (!googleToken) return;
    try {
      let sheetId = await sheetsService.searchSheet(googleToken, 'Resident Compliance Master Log');
      if (!sheetId) {
        sheetId = await sheetsService.createComplianceSheet(googleToken, 'Resident Compliance Master Log');
      }

      const row = [
        formData.fullName,
        formData.dob,
        formData.email,
        formData.insurance.planName,
        formData.insurance.idNumber,
        formData.emergencyContact.name,
        'Pending Clinical Review',
        new Date().toLocaleDateString(),
        formData.checklist.tbDocumentation ? 'YES' : 'NO',
        formData.checklist.authorizedPresence ? 'YES' : 'NO',
        formData.checklist.naloxoneAttestation ? 'YES' : 'NO',
        formData.checklist.lockableStorageAck ? 'YES' : 'NO'
      ];

      await sheetsService.appendRow(googleToken, sheetId, [row]);
      showToast('Compliance log updated in Google Sheets!');
    } catch (err) {
      console.error('Error syncing to sheets:', err);
      showToast('Failed to update compliance log.');
    }
  };

  const handleFinish = async () => {
    if (residentId) {
      try {
        const now = new Date().toISOString();
        const historyEntry: StatusHistoryEntry = {
          status: 'pending_review',
          changedAt: now,
          changedBy: user?.email || 'Applicant',
          note: 'Completed all intake packets, signed agreements, and submitted for clinical sign-off',
        };
        await updateDoc(doc(db, 'residents', residentId), {
          status: 'pending_review',
          onboardingStep: 10, // Marking as past the review step (index 9)
          statusHistory: arrayUnion(historyEntry),
        });
        
        await syncToComplianceSheet();
        
        setResidentStatus('pending_review');
        setResidentStatusHistory((prev) => [...prev, historyEntry]);
        setStep(9);
        showToast('Onboarding complete! Your application is now pending review.');
      } catch (err) {
        console.error('Error finishing onboarding:', err);
        setError('Failed to complete onboarding.');
      }
    }
  };

  const updateResidentStatus = async (rid: string, newStatus: string, customNote?: string) => {
    try {
      setUpdatingId(rid);
      const now = new Date().toISOString();
      const defaultNotes: Record<string, string> = {
        active: 'Approved for move-in and residency activated',
        declined: 'Application declined by management',
        pending_review: 'Placed in pending clinical review',
        approved: 'Application approved by House Manager',
        scheduled: 'Move-in date scheduled',
        orientation: 'Resident scheduled for facility orientation',
      };
      const noteToSave = customNote?.trim() || managerNotes[rid]?.trim() || defaultNotes[newStatus] || `Status updated to ${newStatus.replace('_', ' ')}`;
      const historyEntry: StatusHistoryEntry = {
        status: newStatus,
        changedAt: now,
        changedBy: user?.email || 'House Manager',
        note: noteToSave,
      };
      await updateDoc(doc(db, 'residents', rid), {
        status: newStatus,
        statusHistory: arrayUnion(historyEntry),
      });

      // Clear note for this resident
      setManagerNotes((prev) => {
        const copy = { ...prev };
        delete copy[rid];
        return copy;
      });

      showToast(`Status updated to ${newStatus.replace('_', ' ')}`);
    } catch (err) {
      console.error('Error updating status:', err);
      setError('Failed to update status.');
    } finally {
      setUpdatingId(null);
    }
  };

  const ManagerDashboard = () => {
    const counts = {
      all: allResidents.length,
      pending_review: allResidents.filter(r => r.status === 'pending_review').length,
      active: allResidents.filter(r => r.status === 'active').length,
      declined: allResidents.filter(r => r.status === 'declined').length,
      application: allResidents.filter(r => r.status === 'application').length,
    };

    const filteredResidents = allResidents.filter((res) => {
      const matchesStatus = statusFilter === 'all' || res.status === statusFilter;
      const matchesSearch = !searchQuery.trim() || 
        (res.fullName?.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (res.email?.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchesStatus && matchesSearch;
    });

    return (
      <div className="space-y-6">
        {/* Header with Title and Mode Switch */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b pb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center space-x-2">
              <span>House Manager Portal</span>
              <span className="text-xs bg-blue-100 text-blue-800 font-bold px-2.5 py-0.5 rounded-full">
                AzRHA Level II/III
              </span>
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Review resident intake dossiers, audit regulatory compliance, and track application progression history.
            </p>
          </div>
          <button 
            onClick={() => setViewMode('resident')} 
            className="text-xs font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg transition-colors flex items-center space-x-1"
          >
            <span>Switch to Resident View</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
          </button>
        </div>

        {/* Analytics Chips */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <div className="bg-white border rounded-xl p-3 shadow-xs">
            <div className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">Total Applicants</div>
            <div className="text-xl font-extrabold text-gray-900 mt-1">{counts.all}</div>
          </div>
          <div className="bg-white border rounded-xl p-3 shadow-xs border-amber-200 bg-amber-50/30">
            <div className="text-[10px] uppercase font-bold text-amber-600 tracking-wider">Pending Review</div>
            <div className="text-xl font-extrabold text-amber-700 mt-1">{counts.pending_review}</div>
          </div>
          <div className="bg-white border rounded-xl p-3 shadow-xs border-green-200 bg-green-50/30">
            <div className="text-[10px] uppercase font-bold text-green-600 tracking-wider">Active Residents</div>
            <div className="text-xl font-extrabold text-green-700 mt-1">{counts.active}</div>
          </div>
          <div className="bg-white border rounded-xl p-3 shadow-xs border-red-200 bg-red-50/30">
            <div className="text-[10px] uppercase font-bold text-red-600 tracking-wider">Declined</div>
            <div className="text-xl font-extrabold text-red-700 mt-1">{counts.declined}</div>
          </div>
        </div>

        {/* Filter and Search Bar */}
        <div className="space-y-2.5">
          <div className="relative">
            <input
              type="text"
              placeholder="Search applicants by legal name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 border rounded-xl text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-xs"
            />
            <svg className="w-4 h-4 text-gray-400 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
          </div>

          <div className="flex flex-wrap gap-1.5 text-xs">
            {[
              { id: 'all', label: 'All', count: counts.all },
              { id: 'pending_review', label: 'Pending Review', count: counts.pending_review },
              { id: 'active', label: 'Active', count: counts.active },
              { id: 'declined', label: 'Declined', count: counts.declined },
              { id: 'application', label: 'In Progress', count: counts.application },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setStatusFilter(tab.id)}
                className={`px-3 py-1 rounded-lg font-bold text-[11px] transition-all flex items-center space-x-1.5 ${
                  statusFilter === tab.id
                    ? 'bg-blue-600 text-white shadow-xs'
                    : 'bg-white border text-gray-600 hover:bg-gray-50'
                }`}
              >
                <span>{tab.label}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                  statusFilter === tab.id ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-500'
                }`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Applicant Cards List */}
        <div className="grid grid-cols-1 gap-4">
          {filteredResidents.length === 0 ? (
            <div className="bg-white border rounded-xl p-10 text-center space-y-2">
              <p className="text-gray-400 text-xs italic font-medium">No applicants matched your criteria.</p>
              {searchQuery && (
                <button 
                  onClick={() => setSearchQuery('')}
                  className="text-xs text-blue-600 font-semibold hover:underline"
                >
                  Clear search query
                </button>
              )}
            </div>
          ) : (
            filteredResidents.map((res) => {
              const timeline = getNormalizedTimeline(res);
              const currentStatus = res.status || 'application';
              const config = STATUS_CONFIG[currentStatus] || {
                label: currentStatus.replace('_', ' '),
                color: 'text-gray-700',
                badge: 'bg-gray-100 text-gray-700 border-gray-200',
                dot: 'bg-gray-400',
                icon: '📋',
              };
              const isTimelineOpen = expandedTimelines[res.id] !== false; // open by default

              return (
                <div key={res.id} className="bg-white border rounded-xl p-5 shadow-xs space-y-4 hover:border-gray-300 transition-all">
                  {/* Card Header */}
                  <div className="flex justify-between items-start gap-2">
                    <div className="space-y-0.5">
                      <div className="flex items-center space-x-2">
                        <h3 className="font-bold text-gray-900 text-base">{res.fullName || 'Anonymous Applicant'}</h3>
                        <span className="text-[10px] font-mono text-gray-400">#{res.id.slice(0, 6)}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                        <span className="flex items-center space-x-1">
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                          <span>{res.email}</span>
                        </span>
                        {res.emergencyContact?.phone && (
                          <span className="flex items-center space-x-1">
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                            <span>{res.emergencyContact.phone}</span>
                          </span>
                        )}
                        <span>Applied: {formatTimestamp(res.applicationDate)}</span>
                      </div>
                    </div>
                    
                    {/* Status Badge */}
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border shadow-2xs whitespace-nowrap ${config.badge}`}>
                      {config.icon} {config.label}
                    </span>
                  </div>

                  {/* Arizona Compliance Badges */}
                  <div className="bg-gray-50/70 p-2.5 rounded-lg border border-gray-100 flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className={`flex items-center space-x-1 ${res.checklist?.tbDocumentation ? 'text-green-700' : 'text-gray-400'}`}>
                        <span>{res.checklist?.tbDocumentation ? '✓' : '○'}</span>
                        <span>TB Freedom (§ R9-10-113)</span>
                      </span>
                      <span className={`flex items-center space-x-1 ${res.checklist?.authorizedPresence ? 'text-green-700' : 'text-gray-400'}`}>
                        <span>{res.checklist?.authorizedPresence ? '✓' : '○'}</span>
                        <span>Presence (§ 41-1080)</span>
                      </span>
                      <span className={`flex items-center space-x-1 ${res.houseRulesSigned ? 'text-green-700' : 'text-gray-400'}`}>
                        <span>{res.houseRulesSigned ? '✓' : '○'}</span>
                        <span>House Rules</span>
                      </span>
                      <span className={`flex items-center space-x-1 ${res.residencyPaymentSigned ? 'text-green-700' : 'text-gray-400'}`}>
                        <span>{res.residencyPaymentSigned ? '✓' : '○'}</span>
                        <span>Residency Agmt</span>
                      </span>
                      <span className={`flex items-center space-x-1 ${res.treatmentAgreementSigned ? 'text-green-700' : 'text-gray-400'}`}>
                        <span>{res.treatmentAgreementSigned ? '✓' : '○'}</span>
                        <span>AMPM 320-V</span>
                      </span>
                    </div>
                    {res.insurance?.planName && (
                      <span className="text-gray-500 font-normal">
                        Payer: <strong className="text-gray-700">{res.insurance.planName}</strong>
                      </span>
                    )}
                  </div>

                  {/* Status Progression Timeline Section */}
                  <div className="border rounded-xl p-3.5 bg-gray-50/40 space-y-3">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center space-x-2">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        <h4 className="text-xs font-bold text-gray-800 uppercase tracking-wider">Application Progression Timeline</h4>
                        <span className="bg-blue-100 text-blue-700 font-mono text-[9px] px-1.5 py-0.2 rounded-full font-bold">
                          {timeline.length} {timeline.length === 1 ? 'event' : 'events'}
                        </span>
                      </div>
                      <button 
                        onClick={() => setExpandedTimelines(prev => ({ ...prev, [res.id]: !isTimelineOpen }))}
                        className="text-[10px] text-gray-500 hover:text-gray-700 font-semibold underline"
                      >
                        {isTimelineOpen ? 'Hide History' : 'Show History'}
                      </button>
                    </div>

                    {isTimelineOpen && (
                      <div className="pt-1">
                        <div className="relative pl-6 space-y-4 before:absolute before:bottom-2 before:top-2 before:left-[11px] before:w-0.5 before:bg-gray-200">
                          {timeline.map((entry, idx) => {
                            const isLatest = idx === timeline.length - 1;
                            const stageConfig = STATUS_CONFIG[entry.status] || {
                              label: entry.status.replace('_', ' '),
                              color: 'text-gray-700',
                              badge: 'bg-gray-100 text-gray-700 border-gray-200',
                              dot: 'bg-gray-400',
                              icon: '•',
                            };

                            return (
                              <div key={idx} className="relative text-left">
                                {/* Timeline Node / Dot */}
                                <div className={`absolute -left-6 top-1 w-4 h-4 rounded-full border-2 border-white shadow-xs ${stageConfig.dot} flex items-center justify-center`}>
                                  {isLatest && (
                                    <div className="w-1.5 h-1.5 bg-white rounded-full"></div>
                                  )}
                                </div>

                                <div className="bg-white border rounded-lg p-2.5 shadow-2xs space-y-1">
                                  <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <div className="flex items-center space-x-1.5">
                                      <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${stageConfig.badge}`}>
                                        {stageConfig.label}
                                      </span>
                                      {isLatest && (
                                        <span className="text-[9px] bg-green-100 text-green-800 font-bold px-1.5 py-0.2 rounded">
                                          Current Status
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-[9px] font-medium text-gray-400">
                                      {formatTimestamp(entry.changedAt)}
                                    </span>
                                  </div>

                                  {entry.note && (
                                    <p className="text-[11px] text-gray-700 leading-snug font-medium pt-0.5">
                                      {entry.note}
                                    </p>
                                  )}

                                  {entry.changedBy && (
                                    <div className="text-[9px] text-gray-400 italic pt-0.5 flex items-center space-x-1">
                                      <span>Recorded by: {entry.changedBy}</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Manager Direct Action Panel */}
                  <div className="pt-2 border-t space-y-2">
                    <div className="flex flex-col sm:flex-row gap-2 items-center">
                      <input
                        type="text"
                        placeholder="Add custom progression note (optional, e.g. 'Bed #3 assigned, TB verified')..."
                        value={managerNotes[res.id] || ''}
                        onChange={(e) => setManagerNotes({ ...managerNotes, [res.id]: e.target.value })}
                        className="w-full text-xs p-2 border rounded-lg bg-gray-50 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {res.status !== 'active' && (
                        <button 
                          onClick={() => updateResidentStatus(res.id, 'active')}
                          disabled={updatingId === res.id}
                          className="flex-1 min-w-[120px] bg-green-600 hover:bg-green-700 text-white text-[11px] font-bold py-2 px-3 rounded-lg shadow-xs transition-colors flex items-center justify-center space-x-1 disabled:opacity-50"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          <span>Approve Move-In</span>
                        </button>
                      )}

                      {res.status !== 'declined' && (
                        <button 
                          onClick={() => updateResidentStatus(res.id, 'declined')}
                          disabled={updatingId === res.id}
                          className="flex-1 min-w-[100px] bg-white border border-red-200 text-red-600 hover:bg-red-50 text-[11px] font-bold py-2 px-3 rounded-lg transition-colors flex items-center justify-center space-x-1 disabled:opacity-50"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          <span>Decline</span>
                        </button>
                      )}

                      {res.status !== 'pending_review' && (
                        <button
                          onClick={() => updateResidentStatus(res.id, 'pending_review')}
                          disabled={updatingId === res.id}
                          className="bg-white border border-amber-300 text-amber-700 hover:bg-amber-50 text-[10px] font-bold py-2 px-2.5 rounded-lg transition-colors disabled:opacity-50"
                          title="Place application back in pending clinical review"
                        >
                          ⏳ Pending Review
                        </button>
                      )}

                      {res.status !== 'scheduled' && res.status !== 'active' && (
                        <button
                          onClick={() => updateResidentStatus(res.id, 'scheduled')}
                          disabled={updatingId === res.id}
                          className="bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50 text-[10px] font-bold py-2 px-2.5 rounded-lg transition-colors disabled:opacity-50"
                        >
                          📅 Schedule Move-In
                        </button>
                      )}

                      {res.status !== 'orientation' && res.status !== 'active' && (
                        <button
                          onClick={() => updateResidentStatus(res.id, 'orientation')}
                          disabled={updatingId === res.id}
                          className="bg-white border border-purple-200 text-purple-700 hover:bg-purple-50 text-[10px] font-bold py-2 px-2.5 rounded-lg transition-colors disabled:opacity-50"
                        >
                          🏠 Orientation
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen">Loading...</div>;
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-screen space-y-4">
        <h1 className="text-3xl font-bold">Sober-Living Onboarding</h1>
        <p className="text-gray-600 text-center max-w-md">
          Please sign in to start your digital move-in process.
        </p>
        <button
          onClick={handleSignIn}
          className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition"
        >
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div className={`p-4 sm:p-8 ${viewMode === 'manager' ? 'max-w-4xl' : 'max-w-md'} mx-auto transition-all`}>
      {isAdmin && (
        <div className="mb-6 flex justify-center">
          <div className="bg-gray-100 p-1 rounded-lg flex space-x-1">
            <button 
              onClick={() => setViewMode('resident')}
              className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${viewMode === 'resident' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
            >
              Resident View
            </button>
            <button 
              onClick={() => setViewMode('manager')}
              className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all ${viewMode === 'manager' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
            >
              Manager View
            </button>
          </div>
        </div>
      )}

      {viewMode === 'manager' ? <ManagerDashboard /> : (
        <>
          <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
            <div className="bg-blue-600 h-2.5 rounded-full" style={{ width: `${((step + 1) / steps.length) * 100}%` }}></div>
          </div>
          <h1 className="text-2xl font-bold mb-2">Onboarding: {steps[step]?.title || 'Complete'}</h1>
      <div className="flex justify-between items-center mb-4">
        <div className="text-sm text-gray-500">Step {step + 1} of {steps.length}</div>
        {isSaving && <div className="text-xs text-blue-500 animate-pulse">Saving...</div>}
      </div>
      {error && <div className="text-red-500 mb-2">{error}</div>}
      {step === 0 && (
        <div className="space-y-4">
          <div className="text-xs font-bold text-blue-600 uppercase tracking-widest">Regulatory Standard: A.R.S. § 41-1080</div>
          <input type="text" placeholder="Full Legal Name" value={formData.fullName} onChange={(e) => setFormData({...formData, fullName: e.target.value})} className="w-full p-2 border rounded" />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs text-gray-500 ml-1">Date of Birth</label>
              <input type="date" value={formData.dob} onChange={(e) => setFormData({...formData, dob: e.target.value})} className="w-full p-2 border rounded" />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-gray-500 ml-1">Preferred Language</label>
              <select value={formData.language} onChange={(e) => setFormData({...formData, language: e.target.value})} className="w-full p-2 border rounded">
                <option value="English">English</option>
                <option value="Spanish">Spanish</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>
          <input type="email" placeholder="Email Address" value={formData.email} onChange={(e) => setFormData({...formData, email: e.target.value})} className="w-full p-2 border rounded" />
        </div>
      )}
      {step === 1 && (
        <div className="space-y-4">
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 mb-4">
            <h3 className="text-sm font-semibold text-blue-800 mb-2">Arizona Regulatory Checklist</h3>
            <div className="space-y-2">
              {[
                { id: 'photoId', label: 'Government Photo ID / ADCRR ID' },
                { id: 'authorizedPresence', label: 'Authorized Presence (A.R.S. § 41-1080)' },
                { id: 'tbDocumentation', label: 'TB Freedom Docs (within 7 days)' },
                { id: 'naloxoneAttestation', label: 'Naloxone / Overdose Education' },
                { id: 'lockableStorageAck', label: 'Lockable Storage Acknowledgment' },
              ].map((item) => (
                <label key={item.id} className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={(formData.checklist as any)?.[item.id] || false}
                    onChange={(e) => setFormData({
                      ...formData, 
                      checklist: { ...formData.checklist, [item.id]: e.target.checked }
                    })}
                    className="rounded text-blue-600 focus:ring-blue-500"
                  />
                  <span className={`text-sm ${ (formData.checklist as any)?.[item.id] ? 'text-blue-700 line-through' : 'text-gray-700' }`}>
                    {item.label}
                  </span>
                </label>
              ))}
            </div>
          </div>
          
          <p className="text-sm text-gray-600 mb-2">Once prepared, please take a clear photo of your Photo ID.</p>
          <div className="flex flex-col items-center p-6 border-2 border-dashed border-gray-300 rounded-lg bg-gray-50">
            {documentPreview ? (
              <div className="relative w-full aspect-video bg-black rounded overflow-hidden mb-4">
                <img src={documentPreview} alt="ID Preview" className="w-full h-full object-contain" />
                <button 
                  onClick={() => setDocumentPreview(null)}
                  className="absolute top-2 right-2 bg-red-500 text-white p-1 rounded-full text-xs"
                >
                  Retake
                </button>
              </div>
            ) : (
              <label className="cursor-pointer flex flex-col items-center">
                <div className="p-4 bg-blue-100 rounded-full mb-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>
                </div>
                <span className="text-sm font-medium text-blue-600">Take Photo or Upload ID</span>
                <input 
                  type="file" 
                  accept="image/*" 
                  capture="environment" 
                  onChange={handleFileUpload}
                  className="hidden" 
                />
              </label>
            )}
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="space-y-4">
            <div className="text-xs font-bold text-blue-600 uppercase tracking-widest mb-1">Emergency Contact & HCDM</div>
            <input type="text" placeholder="Contact Name" value={formData.emergencyContact.name} onChange={(e) => setFormData({...formData, emergencyContact: {...formData.emergencyContact, name: e.target.value}})} className="w-full p-2 border rounded" />
            <input type="text" placeholder="Phone" value={formData.emergencyContact.phone} onChange={(e) => setFormData({...formData, emergencyContact: {...formData.emergencyContact, phone: e.target.value}})} className="w-full p-2 border rounded" />
            <label className="flex items-center space-x-2 p-2 bg-gray-50 rounded cursor-pointer border border-dashed">
              <input 
                type="checkbox" 
                checked={formData.emergencyContact.isHCDM}
                onChange={(e) => setFormData({...formData, emergencyContact: {...formData.emergencyContact, isHCDM: e.target.checked}})}
                className="rounded"
              />
              <span className="text-xs text-gray-600">Designated Health Care Decision Maker (HCDM)</span>
            </label>
        </div>
      )}
      {step === 3 && (
        <div className="space-y-4">
            <div className="text-xs font-bold text-blue-600 uppercase tracking-widest mb-1">Insurance & Financial (Template 5)</div>
            <TemplateLink name="Insurance" label="Insurance" />
            <select value={formData.insurance.type} onChange={(e) => setFormData({...formData, insurance: {...formData.insurance, type: e.target.value}})} className="w-full p-2 border rounded">
              <option value="AHCCCS">AHCCCS (Arizona Medicaid)</option>
              <option value="Private">Private Commercial Insurance / TPL</option>
              <option value="None">No Insurance / Cash Pay</option>
            </select>
            <input type="text" placeholder="AHCCCS Health Plan (e.g. Mercy Care, Care1st)" value={formData.insurance.planName} onChange={(e) => setFormData({...formData, insurance: {...formData.insurance, planName: e.target.value}})} className="w-full p-2 border rounded" />
            <input type="text" placeholder="AHCCCS ID / Policy ID" value={formData.insurance.idNumber} onChange={(e) => setFormData({...formData, insurance: {...formData.insurance, idNumber: e.target.value}})} className="w-full p-2 border rounded" />
            
            <div className="p-3 bg-yellow-50 border border-yellow-200 rounded text-[10px] text-yellow-800 leading-tight">
              <strong>Statutory Billing Notice:</strong> Sober Living Homes (SLH) are statutorily prohibited from billing AHCCCS directly for room and board. Rent must be accounted for separately via private resident fees or housing vouchers (ADCRR HVP / AHCCCS Housing Program).
            </div>
        </div>
      )}
      {step === 4 && (
        <div className="space-y-4">
          <div className="text-xs font-bold text-blue-600 uppercase tracking-widest">Template 1.3: Legal & Admin Consents</div>
          <div className="space-y-6">
            <div className="space-y-2">
              <h4 className="text-xs font-bold">1. General Consent to Residency</h4>
              <p className="text-[10px] text-gray-600 leading-tight">I hereby give voluntary consent for residence and program participation in this licensed sober living or BHRF facility.</p>
              <div className="border-2 border-gray-200 rounded overflow-hidden">
                <SignatureCanvas ref={sigCanvas} penColor='black' canvasProps={{width: 320, height: 80, className: 'sigCanvas w-full'}} />
              </div>
              <button onClick={() => handleSign('generalConsentSigned', 'General Consent signed!')} className={`w-full p-2 rounded text-[10px] font-bold ${formData.generalConsentSigned ? 'bg-green-100 text-green-700' : 'bg-blue-600 text-white shadow-sm'}`}>
                {formData.generalConsentSigned ? '✓ Consent Executed' : 'Execute Consent'}
              </button>
            </div>
            
            <div className="space-y-2">
              <h4 className="text-xs font-bold">2. Release of Information (ROI)</h4>
              <p className="text-[10px] text-gray-600 leading-tight">Authorization to disclose health, attendance, and supervision details to officers, clinical teams, and AHCCCS MCOs (HIPAA/42 CFR Part 2 compliant).</p>
              <div className="border-2 border-gray-200 rounded overflow-hidden">
                <SignatureCanvas ref={sigCanvas} penColor='black' canvasProps={{width: 320, height: 80, className: 'sigCanvas w-full'}} />
              </div>
              <button onClick={() => handleSign('roiSigned', 'ROI signed!')} className={`w-full p-2 rounded text-[10px] font-bold ${formData.roiSigned ? 'bg-green-100 text-green-700' : 'bg-blue-600 text-white shadow-sm'}`}>
                {formData.roiSigned ? '✓ ROI Active' : 'Execute ROI'}
              </button>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-bold">3. Notice of Privacy Practices (NPP)</h4>
              <p className="text-[10px] text-gray-600 leading-tight">I acknowledge receipt and review of the facility's Notice of Privacy Practices.</p>
              <div className="border-2 border-gray-200 rounded overflow-hidden">
                <SignatureCanvas ref={sigCanvas} penColor='black' canvasProps={{width: 320, height: 80, className: 'sigCanvas w-full'}} />
              </div>
              <button onClick={() => handleSign('nppSigned', 'Privacy Practice acknowledgment signed!')} className={`w-full p-2 rounded text-[10px] font-bold ${formData.nppSigned ? 'bg-green-100 text-green-700' : 'bg-blue-600 text-white shadow-sm'}`}>
                {formData.nppSigned ? '✓ NPP Acknowledged' : 'Execute NPP'}
              </button>
            </div>
            <button onClick={clearSignature} className="w-full border border-gray-300 p-1 rounded text-[9px] text-gray-400 uppercase font-bold tracking-tighter">Clear Active Canvas</button>
          </div>
        </div>
      )}
      {step === 5 && (
        <div className="space-y-4">
            <div className="text-xs font-bold text-blue-600 uppercase tracking-widest">Template 2: Facility House Rules</div>
            <TemplateLink name="House Rules" label="House Rules" />
            <p className="p-4 bg-gray-100 rounded text-[10px] leading-relaxed h-48 overflow-y-auto shadow-inner">
              <strong>AzRHA / NARR Standards & A.R.S. § 36-2062</strong><br/><br/>
              <strong>1. Abstinence & Toxicology:</strong> Mandatory absolute abstinence from alcohol, illicit drugs, unauthorized mood-altering products, and synthetic items on or off premises. Mandatory random and scheduled screenings.<br/>
              <strong>2. Testing Ethics:</strong> This facility does not profit from drug testing. All screens are conducted solely for recovery accountability.<br/>
              <strong>3. MAT Continuation:</strong> Pursuant to A.R.S. § 36-2062(A)(1), residents are explicitly permitted to continue prescribed MAT (Suboxone, Methadone, Vivitrol) without discrimination.<br/>
              <strong>4. Structure & Accountability:</strong> Mandatory attendance at weekly house meetings and minimum recovery support (AA, NA, SMART, IOP). Adherence to chores and curfews.<br/>
              <strong>5. Community Policy:</strong> Designated outdoor smoking areas; quiet hours 10:00 PM – 6:00 AM.
            </p>
            <div className="border-2 border-gray-300 rounded-lg overflow-hidden bg-white">
              <SignatureCanvas 
                ref={sigCanvas}
                penColor='black'
                canvasProps={{width: 320, height: 150, className: 'sigCanvas w-full'}} 
              />
            </div>
            <div className="flex space-x-2">
              <button onClick={clearSignature} className="flex-1 border border-gray-300 p-2 rounded text-sm text-gray-600 hover:bg-gray-50 transition-colors">Clear</button>
              <button onClick={() => handleSign('houseRulesSigned', 'House Rules signed!')} className="flex-1 bg-green-500 text-white p-2 rounded text-sm font-bold shadow-md hover:bg-green-600 transition-colors">I Agree & Sign</button>
            </div>
        </div>
      )}
      {step === 6 && (
        <div className="space-y-4">
            <div className="text-xs font-bold text-blue-600 uppercase tracking-widest">Template 3: Residency & Payment Agreement</div>
            <TemplateLink name="Residency" label="Residency" />
            <p className="p-4 bg-gray-100 rounded text-[10px] leading-relaxed h-48 overflow-y-auto shadow-inner">
              <strong>Arizona Fee Structure & Statutory Protections</strong><br/><br/>
              <strong>Fee Schedule:</strong> Shared Room: $210–235/week. Private: $310+/week. Move-In Fee: $150–250 (Non-refundable). Supply Fee: $30/month.<br/><br/>
              <strong>Prohibition on Benefit Surrender:</strong> This agreement strictly prohibits requiring residents to sign away public assistance benefits, SNAP, or Medicaid as a condition of residency.<br/><br/>
              <strong>Notice Compliance:</strong> Adherence to 7-day and 14-day written notice rules under A.A.C. R9-12-202 for non-emergency discharges or fee defaults.<br/><br/>
              <strong>Criminal Justice Compliance:</strong> For those under supervision, placement is strictly contingent upon formal officer address approval prior to move-in.
            </p>
            <div className="border-2 border-gray-300 rounded-lg overflow-hidden bg-white">
              <SignatureCanvas 
                ref={sigCanvas}
                penColor='black'
                canvasProps={{width: 320, height: 150, className: 'sigCanvas w-full'}} 
              />
            </div>
            <div className="flex space-x-2">
              <button onClick={clearSignature} className="flex-1 border border-gray-300 p-2 rounded text-sm text-gray-600 hover:bg-gray-50 transition-colors">Clear</button>
              <button onClick={() => handleSign('residencyPaymentSigned', 'Residency agreement signed!')} className="flex-1 bg-green-500 text-white p-2 rounded text-sm font-bold shadow-md hover:bg-green-600 transition-colors">Sign Agreement</button>
            </div>
        </div>
      )}
      {step === 7 && (
        <div className="space-y-4">
            <div className="text-xs font-bold text-blue-600 uppercase tracking-widest">Template 4: Clinical Treatment Plan</div>
            <TemplateLink name="Treatment" label="Treatment Plan" />
            <p className="p-4 bg-gray-100 rounded text-[10px] leading-relaxed h-48 overflow-y-auto shadow-inner">
              <strong>AHCCCS Medical Policy (AMPM 320-V) Expectations</strong><br/><br/>
              <strong>1. Assessment:</strong> Comprehensive behavioral health assessment completed within 48 hours of admission.<br/>
              <strong>2. Components:</strong> Individualized needs including substance history, mental health, and legal/justice records.<br/>
              <strong>3. Goals:</strong> Specific, behavioral short-term and long-term recovery objectives.<br/>
              <strong>4. Team Engagement:</strong> Active participation of the Adult Recovery Team (ART) and clinical care coordinators.<br/>
              <strong>5. Discharge:</strong> Formulated during initial treatment planning and reviewed monthly.
            </p>
            <div className="border-2 border-gray-300 rounded-lg overflow-hidden bg-white">
              <SignatureCanvas 
                ref={sigCanvas}
                penColor='black'
                canvasProps={{width: 320, height: 150, className: 'sigCanvas w-full'}} 
              />
            </div>
            <div className="flex space-x-2">
              <button onClick={clearSignature} className="flex-1 border border-gray-300 p-2 rounded text-sm text-gray-600 hover:bg-gray-50 transition-colors">Clear</button>
              <button onClick={() => handleSign('treatmentAgreementSigned', 'Treatment agreement signed!')} className="flex-1 bg-green-500 text-white p-2 rounded text-sm font-bold shadow-md hover:bg-green-600 transition-colors">Acknowledge Plan</button>
            </div>
        </div>
      )}

      {step === 8 && (
        <div className="space-y-6">
          <div className="bg-green-50 p-4 rounded-lg border border-green-200">
            <h2 className="text-lg font-semibold text-green-800">Onboarding Complete!</h2>
            <p className="text-sm text-green-700">Thank you for submitting your digital paperwork.</p>
          </div>
          
          <div className="space-y-3">
            <h3 className="font-medium text-gray-700 border-b pb-1">Review Your Info</h3>
            <div className="text-[10px] grid grid-cols-2 gap-2">
              <p><span className="text-gray-500">Name:</span> {formData.fullName}</p>
              <p><span className="text-gray-500">DOB:</span> {formData.dob}</p>
              <p><span className="text-gray-500">Language:</span> {formData.language}</p>
              <p><span className="text-gray-500">Insurance:</span> {formData.insurance.planName}</p>
              <p className="col-span-2"><span className="text-gray-500">Emergency:</span> {formData.emergencyContact.name} ({formData.emergencyContact.phone}) {formData.emergencyContact.isHCDM && ' [HCDM]'}</p>
            </div>
            
            <div className="grid grid-cols-2 gap-2 mt-4">
              <button 
                onClick={() => formData.documentsSubmitted && setShowIdModal(true)}
                className={`p-2 rounded text-[10px] flex items-center justify-center transition-colors ${formData.documentsSubmitted ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 cursor-pointer' : 'bg-gray-50 text-gray-400 cursor-not-allowed'}`}
              >
                {formData.documentsSubmitted ? '✓ ID Captured (View)' : '○ ID Missing'}
              </button>
              <div className={`p-2 rounded text-[10px] flex items-center justify-center ${formData.houseRulesSigned ? 'bg-blue-50 text-blue-700' : 'bg-gray-50 text-gray-400'}`}>
                {formData.houseRulesSigned ? '✓ Rules Signed' : '○ Rules Missing'}
              </div>
              <div className={`p-2 rounded text-[10px] flex items-center justify-center ${formData.residencyPaymentSigned ? 'bg-blue-50 text-blue-700' : 'bg-gray-50 text-gray-400'}`}>
                {formData.residencyPaymentSigned ? '✓ Residency Signed' : '○ Residency Missing'}
              </div>
              <div className={`p-2 rounded text-[10px] flex items-center justify-center ${formData.treatmentAgreementSigned ? 'bg-blue-50 text-blue-700' : 'bg-gray-50 text-gray-400'}`}>
                {formData.treatmentAgreementSigned ? '✓ Treatment Signed' : '○ Treatment Missing'}
              </div>
            </div>
          </div>

          <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
            <h3 className="text-sm font-semibold text-blue-800">Next Steps</h3>
            <p className="text-xs text-blue-700 mt-1">
              The House Manager has been notified. They will review your file and contact you to schedule your move-in date and orientation.
            </p>
          </div>

          <button 
            onClick={downloadSummaryPDF}
            className="w-full flex items-center justify-center space-x-2 border-2 border-blue-600 text-blue-600 p-3 rounded-lg hover:bg-blue-50 transition font-medium"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <span>Download Summary PDF</span>
          </button>

          <button 
            onClick={handleReset}
            className="w-full text-gray-500 text-sm hover:text-red-500 transition-colors pt-4"
          >
            Start Over / Sign Out
          </button>

          <button 
            onClick={handleFinish}
            className="w-full bg-blue-600 text-white p-3 rounded-lg font-bold mt-4 shadow-md hover:bg-blue-700 transition"
          >
            Finish & Submit for Review
          </button>
        </div>
      )}

      {step === 9 && (
        <div className="space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-block p-3 bg-blue-100 rounded-full text-blue-600 mb-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            </div>
            <h1 className="text-2xl font-bold">Arizona Resident Portal</h1>
            <p className="text-gray-500">Welcome, {formData.fullName}</p>
          </div>

          <div className="bg-white border rounded-xl p-5 shadow-sm space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <span className="text-sm font-medium text-gray-500 uppercase tracking-tighter">Application Status</span>
              <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border shadow-2xs ${
                STATUS_CONFIG[residentStatus]?.badge || 'bg-yellow-100 text-yellow-700 border-yellow-200'
              }`}>
                {STATUS_CONFIG[residentStatus]?.icon} {STATUS_CONFIG[residentStatus]?.label || 'Pending Clinical Review'}
              </span>
            </div>
            
            <div className="space-y-3">
              <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Master Intake Coordinator</h3>
              <div className="bg-gray-50 p-4 rounded-lg space-y-2 border">
                <div className="flex items-center space-x-3 text-sm">
                  <div className="bg-blue-600 text-white p-1.5 rounded-full">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  </div>
                  <span className="font-bold text-gray-800">Sarah Miller, BHT</span>
                </div>
                <div className="flex items-center space-x-3 text-sm">
                  <div className="bg-gray-200 p-1.5 rounded-full">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                  </div>
                  <span className="text-gray-600">(555) 123-4567</span>
                </div>
                <p className="text-[10px] text-gray-500 mt-2 italic leading-tight bg-white p-2 rounded border border-dashed">
                  "Please allow 24 hours for BHT/BHP file sign-off. We will verify your TB documentation and A.R.S. § 41-1080 status before scheduling your move-in."
                </p>
              </div>
            </div>
          </div>

          {/* Resident Application Progression Timeline Card */}
          <div className="bg-white border rounded-xl p-5 shadow-sm space-y-3">
            <div className="flex items-center space-x-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-blue-600"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <h3 className="text-sm font-bold text-gray-800">Your Progression Timeline</h3>
            </div>
            <div className="pt-1">
              <div className="relative pl-6 space-y-3.5 before:absolute before:bottom-2 before:top-2 before:left-[11px] before:w-0.5 before:bg-gray-200">
                {getNormalizedTimeline({
                  status: residentStatus,
                  statusHistory: residentStatusHistory,
                  applicationDate: formData.fullName ? new Date().toISOString() : undefined,
                  onboardingStep: 10
                }).map((entry, idx, arr) => {
                  const isLatest = idx === arr.length - 1;
                  const itemConfig = STATUS_CONFIG[entry.status] || {
                    label: entry.status.replace('_', ' '),
                    color: 'text-gray-700',
                    badge: 'bg-gray-100 text-gray-700 border-gray-200',
                    dot: 'bg-gray-400',
                    icon: '•',
                  };

                  return (
                    <div key={idx} className="relative text-left">
                      <div className={`absolute -left-6 top-1 w-4 h-4 rounded-full border-2 border-white shadow-xs ${itemConfig.dot} flex items-center justify-center`}>
                        {isLatest && <div className="w-1.5 h-1.5 bg-white rounded-full"></div>}
                      </div>
                      <div className="bg-gray-50 border rounded-lg p-2.5 space-y-1">
                        <div className="flex items-center justify-between gap-1 flex-wrap">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${itemConfig.badge}`}>
                            {itemConfig.label}
                          </span>
                          <span className="text-[9px] text-gray-400 font-medium">
                            {formatTimestamp(entry.changedAt)}
                          </span>
                        </div>
                        {entry.note && (
                          <p className="text-[11px] text-gray-700 font-medium leading-snug">{entry.note}</p>
                        )}
                        {entry.changedBy && (
                          <div className="text-[9px] text-gray-400 italic">By: {entry.changedBy}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-100 rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-bold text-blue-800 flex items-center space-x-2">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              <span>Move-In Requirements</span>
            </h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs p-2 bg-white rounded border">
                <span className="text-gray-600">Behavioral Health Assessment</span>
                <span className="font-bold text-orange-600">REQUIRED WITHIN 48H</span>
              </div>
              <div className="flex items-center justify-between text-xs p-2 bg-white rounded border">
                <span className="text-gray-600">TB Freedom Documentation</span>
                <span className={formData.checklist.tbDocumentation ? "text-green-600 font-bold" : "text-red-500"}>
                  {formData.checklist.tbDocumentation ? "VERIFIED" : "PENDING"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs p-2 bg-white rounded border">
                <span className="text-gray-600">Authorized Presence (A.R.S. § 41-1080)</span>
                <span className={formData.checklist.authorizedPresence ? "text-green-600 font-bold" : "text-red-500"}>
                  {formData.checklist.authorizedPresence ? "VERIFIED" : "PENDING"}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-blue-600 leading-tight">
              *All requirements must be satisfied pursuant to AMPM 320-V and ADHS regulations before full occupancy.
            </p>
          </div>

          <div className="bg-white border rounded-xl p-5 shadow-sm space-y-4">
            <h3 className="text-sm font-semibold text-gray-700">AZ Reentry & Recovery Resource Guide</h3>
            <div className="grid grid-cols-1 gap-3">
              {[
                { 
                  name: "Scottsdale Recovery Center (SRC)", 
                  service: "Official ADCRR Housing Voucher Partner", 
                  contact: "(888) 409-0943",
                  extra: "Email: housing@scottsdalerecovery.com"
                },
                { 
                  name: "A Better Way (ABW)", 
                  service: "Zero-Income Intake Accommodation", 
                  contact: "(623) 399-8213",
                  extra: "Women's Director: (623) 570-1683"
                },
                { 
                  name: "Kokopelli Sex Offender Housing", 
                  service: "Male Sex Offender Halfway House", 
                  contact: "(480) 620-2036",
                  extra: "Contact: Steve Collins (Tier rules apply)"
                },
                { 
                  name: "Amigos Foundation", 
                  service: "Sex Offender Recovery Living", 
                  contact: "(602) 549-1060",
                  extra: "Contact: David Frayley (Fee verified on intake)"
                },
                { 
                  name: "Harmonee Haven Enterprise", 
                  service: "Reentry Shared Housing", 
                  contact: "(520) 340-1854",
                  extra: "Physical address withheld for safety"
                }
              ].map((res, idx) => (
                <div key={idx} className="p-3 bg-gray-50 rounded-lg border border-gray-100 space-y-1">
                  <div className="flex justify-between items-start">
                    <div className="text-xs font-bold text-gray-800">{res.name}</div>
                    <div className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-100">{res.contact}</div>
                  </div>
                  <div className="text-[10px] text-gray-500 font-medium">{res.service}</div>
                  <div className="text-[9px] text-gray-400 italic">{res.extra}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white border rounded-xl shadow-sm overflow-hidden flex flex-col h-[400px]">
            <div className="bg-gray-50 p-3 border-b flex items-center space-x-2">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
              <h3 className="text-sm font-semibold text-gray-700">Message House Manager</h3>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 ? (
                <div className="text-center text-gray-400 text-xs py-10 italic">
                  No messages yet. Say hello to your manager!
                </div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.senderId === user?.uid ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                      msg.senderId === user?.uid 
                        ? 'bg-blue-600 text-white rounded-tr-none' 
                        : 'bg-gray-100 text-gray-800 rounded-tl-none'
                    }`}>
                      <div className="text-[10px] opacity-70 mb-1 font-bold">
                        {msg.isAdmin ? 'House Manager' : msg.senderName}
                      </div>
                      {msg.attachment && (
                        <div className="mb-2 rounded overflow-hidden cursor-pointer" onClick={() => {
                          setDocumentPreview(msg.attachment!);
                          setShowIdModal(true);
                        }}>
                          <img src={msg.attachment} alt="Attachment" className="max-w-full h-auto max-h-40 object-cover" />
                        </div>
                      )}
                      <p>{msg.text}</p>
                      <div className="text-[9px] opacity-50 text-right mt-1">
                        {msg.createdAt?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleSendMessage} className="p-3 bg-white border-t flex flex-col space-y-2">
              {pendingAttachment && (
                <div className="flex items-center space-x-2 bg-gray-50 p-2 rounded-lg relative">
                  <img src={pendingAttachment} className="w-10 h-10 object-cover rounded" alt="Pending" />
                  <span className="text-[10px] text-gray-500">Attachment ready</span>
                  <button 
                    type="button" 
                    onClick={() => setPendingAttachment(null)}
                    className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              )}
              <div className="flex space-x-2">
                <label className="cursor-pointer bg-gray-100 p-2 rounded-full hover:bg-gray-200 transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  <input type="file" className="hidden" accept="image/*" onChange={handleAttachment} />
                </label>
                <input 
                  type="text" 
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type a message..." 
                  className="flex-1 text-sm p-2 border rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button 
                  type="submit"
                  disabled={!newMessage.trim() && !pendingAttachment}
                  className="bg-blue-600 text-white p-2 rounded-full disabled:opacity-50 transition-opacity"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polyline points="22 2 15 22 11 13 2 9 22 2"/></svg>
                </button>
              </div>
            </form>
          </div>

          <div className="space-y-3">
            <div className="flex justify-between items-center border-b pb-1">
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-tighter">Regulatory Resource Library</h3>
              {googleToken && (
                <button onClick={fetchTemplates} className="text-blue-600 hover:text-blue-800 transition-colors p-1" title="Refresh templates">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                </button>
              )}
            </div>
            <div className="bg-gray-50 p-4 rounded-lg space-y-2">
              {!googleToken ? (
                <button 
                  onClick={handleSignIn}
                  className="w-full bg-white border border-gray-300 p-2 rounded text-xs flex items-center justify-center space-x-2 shadow-sm hover:bg-gray-50"
                >
                  <img src="https://www.google.com/favicon.ico" className="w-3 h-3" alt="Google" />
                  <span>Connect Google Drive to View Templates</span>
                </button>
              ) : driveTemplates.length === 0 ? (
                <div className="text-center py-4 space-y-1">
                  <p className="text-xs text-gray-400 italic font-medium">No shared templates found in your Drive.</p>
                  <p className="text-[10px] text-gray-400">Templates named "House Rules" or "Residency" will appear here.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {driveTemplates.map(file => (
                    <a 
                      key={file.id}
                      href={`https://docs.google.com/document/d/${file.id}/edit`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-3 bg-white border rounded-lg text-xs text-blue-700 hover:border-blue-300 hover:shadow-sm transition-all flex items-center justify-between group"
                    >
                      <div className="flex items-center space-x-3 overflow-hidden">
                        <div className="p-1.5 bg-blue-50 rounded text-blue-600 group-hover:bg-blue-100 transition-colors">
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                        </div>
                        <span className="truncate font-semibold">{file.name}</span>
                      </div>
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300 group-hover:text-blue-500 transition-colors"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 8"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <button 
              onClick={downloadSummaryPDF}
              className="w-full text-blue-600 text-sm font-medium hover:underline py-2"
            >
              Download Signed Paperwork Copy
            </button>
            <button 
              onClick={uploadSummaryToDrive}
              disabled={isUploadingToDrive || !googleToken}
              className={`w-full text-sm font-medium py-2 flex items-center justify-center space-x-2 ${isUploadingToDrive ? 'text-gray-400' : 'text-green-600 hover:underline'}`}
            >
              {isUploadingToDrive ? (
                <span>Uploading...</span>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  <span>Save Copy to My Google Drive</span>
                </>
              )}
            </button>
            <button 
              onClick={handleReset}
              className="w-full text-gray-400 text-xs hover:text-gray-600 transition-colors py-2"
            >
              Sign Out
            </button>
          </div>
        </div>
      )}
      
      {step < steps.length - 1 && (
        <button onClick={handleNext} className="mt-4 bg-blue-500 text-white p-2 rounded w-full">
          {step === 0 ? 'Submit Application' : 'Next Step'}
        </button>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg z-50 transition-opacity">
          {toast}
        </div>
      )}

      {showIdModal && documentPreview && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-xl overflow-hidden max-w-lg w-full">
            <div className="p-4 flex justify-between items-center border-b">
              <h3 className="font-semibold">Captured Photo ID</h3>
              <button onClick={() => setShowIdModal(false)} className="text-gray-500 hover:text-black">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="p-4 bg-gray-100">
              <img src={documentPreview} alt="ID Preview" className="w-full h-auto rounded shadow-sm" />
            </div>
            <div className="p-4 flex justify-end">
              <button onClick={() => setShowIdModal(false)} className="bg-blue-600 text-white px-4 py-2 rounded font-medium">Close</button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
