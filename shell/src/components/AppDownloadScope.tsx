'use client';
import {createContext,useContext,useEffect,useRef,type ReactNode} from 'react';
import {mailDownloadsKey} from '@/lib/mail-downloads';
const Scope=createContext<string|null>(null);
export function useAppDownloadScope(){return useContext(Scope);}
export function AppDownloadScope({scope,children}:{scope:string|null;children:ReactNode}){
 const previous=useRef<string|null>(scope);
 useEffect(()=>{const old=previous.current;previous.current=scope;if(old&&old!==scope){try{localStorage.removeItem(mailDownloadsKey(old));}catch(error){console.warn('[edition-cache] Scope cleanup unavailable',error instanceof Error?error.name:'UnknownError');}}},[scope]);
 return <Scope.Provider value={scope}>{children}</Scope.Provider>;
}
