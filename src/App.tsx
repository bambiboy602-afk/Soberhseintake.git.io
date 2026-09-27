/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, updateDoc } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

const steps = [
  { title: 'Application', fields: ['fullName', 'email'] },
  { title: 'Documents', fields: ['documentsSubmitted'] },
  { title: 'Emergency Contact', fields: ['emergencyContact'] },
  { title: 'House Rules', fields: ['houseRulesSigned'] },
  { title: 'Residency and Payments', fields: ['residencyPaymentSigned'] },
  { title: 'Treatment', fields: ['treatmentAgreementSigned'] },
];

export default function App() {
  const [step, setStep] = useState(0);
  const [residentId, setResidentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    documentsSubmitted: false,
    emergencyContact: { name: '', phone: '', relation: '' },
    houseRulesSigned: false,
    residencyPaymentSigned: false,
    treatmentAgreementSigned: false,
  });

  const handleNext = async () => {
    try {
      if (step === 0) {
        if (!formData.fullName || !formData.email) {
          setError('Full Name and Email are required.');
          return;
        }
        setError(null);
        const docRef = await addDoc(collection(db, 'residents'), {
          ...formData,
          status: 'application',
          applicationDate: new Date().toISOString(),
          onboardingStep: 1,
        });
        setResidentId(docRef.id);
      } else if (residentId) {
        await updateDoc(doc(db, 'residents', residentId), {
          ...formData,
          onboardingStep: step + 1,
        });
      }
      setStep((prev) => prev + 1);
    } catch (error) {
      console.error('Error saving step: ', error);
      setError('An error occurred. Please try again.');
    }
  };

  return (
    <div className="p-8 max-w-md mx-auto">
      <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
        <div className="bg-blue-600 h-2.5 rounded-full" style={{ width: `${((step + 1) / steps.length) * 100}%` }}></div>
      </div>
      <h1 className="text-2xl font-bold mb-4">Onboarding: {steps[step]?.title || 'Complete'}</h1>
      <div className="mb-4">Step {step + 1} of {steps.length}</div>
      {error && <div className="text-red-500 mb-2">{error}</div>}
      {step === 0 && (
        <div className="space-y-4">
          <input type="text" placeholder="Full Name" onChange={(e) => setFormData({...formData, fullName: e.target.value})} className="w-full p-2 border rounded" />
          <input type="email" placeholder="Email" onChange={(e) => setFormData({...formData, email: e.target.value})} className="w-full p-2 border rounded" />
        </div>
      )}
      {step === 1 && <button onClick={() => setFormData({...formData, documentsSubmitted: true})} className="bg-green-500 text-white p-2 rounded">Upload Docs</button>}
      {step === 2 && (
        <div className="space-y-2">
            <input type="text" placeholder="Contact Name" onChange={(e) => setFormData({...formData, emergencyContact: {...formData.emergencyContact, name: e.target.value}})} className="w-full p-2 border rounded" />
            <input type="text" placeholder="Phone" onChange={(e) => setFormData({...formData, emergencyContact: {...formData.emergencyContact, phone: e.target.value}})} className="w-full p-2 border rounded" />
        </div>
      )}
      {step === 3 && (
        <div className="space-y-2">
            <p className="p-4 bg-gray-100 rounded">Default House Rules Contract...</p>
            <button onClick={() => setFormData({...formData, houseRulesSigned: true})} className="bg-green-500 text-white p-2 rounded">Sign House Rules</button>
        </div>
      )}
      {step === 4 && (
        <div className="space-y-2">
            <p className="p-4 bg-gray-100 rounded">Default Residency and Payments Contract...</p>
            <button onClick={() => setFormData({...formData, residencyPaymentSigned: true})} className="bg-green-500 text-white p-2 rounded">Sign Residency/Payment Agreement</button>
        </div>
      )}
      {step === 5 && (
        <div className="space-y-2">
            <p className="p-4 bg-gray-100 rounded">Default Treatment Contract...</p>
            <button onClick={() => setFormData({...formData, treatmentAgreementSigned: true})} className="bg-green-500 text-white p-2 rounded">Sign Treatment Agreement</button>
        </div>
      )}
      
      {step < steps.length && (
        <button onClick={handleNext} className="mt-4 bg-blue-500 text-white p-2 rounded">
          {step === 0 ? 'Submit Application' : 'Next Step'}
        </button>
      )}
    </div>
  );
}
