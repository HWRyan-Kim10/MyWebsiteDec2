import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

// Firebase config (provided by you)
const firebaseConfig = {
  apiKey: 'AIzaSyAmmCNHF3gRUMKkaBPfLSctD5vzSQjZliM',
  authDomain: 'dec2project-2f29.firebaseapp.com',
  projectId: 'dec2project-2f29',
  storageBucket: 'dec2project-2f29.firebasestorage.app',
  messagingSenderId: '476980771986',
  appId: '1:476980771986:web:426cae6e94f09b3c253a4b',
}

export const firebaseApp = initializeApp(firebaseConfig)
export const db = getFirestore(firebaseApp)



