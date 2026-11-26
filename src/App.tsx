import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  DISABLE_FIELD_MEMORY,
  ENABLE_SERVER_LOGOUT,
  apiLogin,
  apiLogout,
  clearStoredSession,
  getStoredSession,
  registerNeedLoginHandler,
  saveStoredSession,
  setActiveSession,
} from './api';
import { ListScreen } from './components/ListScreen';
import { LoginScreen } from './components/LoginScreen';
import { ReportScreen } from './components/ReportScreen';
import type { AppMeta, ScreenName } from './types';

function readInitialSession(): string {
  const stored = getStoredSession();
  if (stored) {
    setActiveSession(stored);
  }
  return stored;
}

export default function App() {
  const initialSessionRef = useRef<string | null>(null);
  if (initialSessionRef.current === null) {
    initialSessionRef.current = readInitialSession();
  }
  const initialSession = initialSessionRef.current;

  const [screen, setScreen] = useState<ScreenName>(() =>
    initialSession ? 'list' : 'login'
  );
  const [session, setSession] = useState<string>(initialSession);
  const [meta, setMeta] = useState<AppMeta | null>(null);
  const [selectedReportNo, setSelectedReportNo] = useState<string>('');
  const [loadingMeta, setLoadingMeta] = useState(false);

  // Overlay login modal state when any API response returns needLogin: true
  const [reauthOpen, setReauthOpen] = useState(false);
  const reauthResolverRef = useRef<((nextSession: string | null) => void) | null>(
    null
  );
  const metaRef = useRef<AppMeta | null>(null);
  metaRef.current = meta;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const loggingOutRef = useRef(false);

  // Register global needLogin handler so failed calls show login card over current screen and retry once
  useEffect(() => {
    registerNeedLoginHandler(() => {
      return new Promise<string | null>((resolve) => {
        reauthResolverRef.current = resolve;
        setReauthOpen(true);
      });
    });

    return () => {
      registerNeedLoginHandler(null);
      if (reauthResolverRef.current) {
        reauthResolverRef.current(null);
        reauthResolverRef.current = null;
      }
    };
  }, []);

  function handleLoginSuccess(nextSession: string, nextMeta?: AppMeta) {
    setActiveSession(nextSession);
    setSession(nextSession);
    saveStoredSession(nextSession);
    if (nextMeta && Array.isArray(nextMeta.order) && nextMeta.blocks) {
      setMeta(nextMeta);
    }
    setScreen('list');
  }

  function handleOverlayLoginSuccess(nextSession: string, nextMeta?: AppMeta) {
    setActiveSession(nextSession);
    setSession(nextSession);
    saveStoredSession(nextSession);
    // Keep existing meta reference if already loaded so active ReportScreen doesn't reset
    if (!metaRef.current && nextMeta && Array.isArray(nextMeta.order) && nextMeta.blocks) {
      setMeta(nextMeta);
    }
    setReauthOpen(false);
    const resolve = reauthResolverRef.current;
    reauthResolverRef.current = null;
    if (resolve) {
      resolve(nextSession);
    }
  }

  async function handleLogout() {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    try {
      if (ENABLE_SERVER_LOGOUT) {
        const currentSession = sessionRef.current || getStoredSession();
        if (currentSession) {
          await apiLogout(currentSession);
        }
      }
    } finally {
      clearStoredSession();
      setActiveSession('');
      setSession('');
      setMeta(null);
      setSelectedReportNo('');
      setReauthOpen(false);
      if (reauthResolverRef.current) {
        reauthResolverRef.current(null);
        reauthResolverRef.current = null;
      }
      loggingOutRef.current = false;
      setScreen('login');
    }
  }

  async function handleSelectReport(reportNo: string) {
    setSelectedReportNo(reportNo);
    if (metaRef.current) {
      setScreen('report');
      return;
    }
    // Load protocol metadata lazily on first report open after restoring a stored session
    setLoadingMeta(true);
    try {
      const res = await apiLogin(sessionRef.current);
      if (res.meta && Array.isArray(res.meta.order) && res.meta.blocks) {
        setMeta(res.meta);
        setScreen('report');
      } else if (metaRef.current) {
        setScreen('report');
      }
    } catch {
      // If re-auth overlay provided meta, still open report; otherwise stay on list
      if (metaRef.current) {
        setScreen('report');
      }
    } finally {
      setLoadingMeta(false);
    }
  }

  function handleBackToList() {
    setScreen('list');
  }

  return (
    <div className="relative min-h-dvh flex flex-col text-[#1d1d1f] overflow-x-clip">
      {/* Fixed ambient color blobs behind Liquid Glass surfaces (static, no animation) */}
      <div className="liquid-bg-canvas" aria-hidden="true">
        <div className="liquid-blob-navy" />
        <div className="liquid-blob-cobalt" />
        <div className="liquid-blob-sky" />
      </div>

      {/* Foreground shell */}
      <div className="relative z-10 flex min-h-dvh flex-col">
        {screen === 'login' ? (
          <LoginScreen onLoginSuccess={handleLoginSuccess} />
        ) : screen === 'report' && selectedReportNo && meta ? (
          <ReportScreen
            key={DISABLE_FIELD_MEMORY ? selectedReportNo : undefined}
            session={session}
            meta={meta}
            reportNo={selectedReportNo}
            onBack={handleBackToList}
          />
        ) : (
          <ListScreen
            session={session}
            onSelectReport={handleSelectReport}
            onLogout={handleLogout}
          />
        )}
      </div>

      {loadingMeta && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="glass-panel flex items-center gap-3 px-6 py-4 text-[13px] font-medium text-[#1d1d1f]">
            <Loader2
              className="h-5 w-5 animate-spin text-[#00227A]"
              aria-hidden="true"
            />
            <span>Opening report...</span>
          </div>
        </div>
      )}

      {reauthOpen && (
        <LoginScreen
          isOverlay={true}
          onLoginSuccess={handleOverlayLoginSuccess}
        />
      )}
    </div>
  );
}
