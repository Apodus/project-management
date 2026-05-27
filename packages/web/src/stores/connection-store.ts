import { create } from "zustand";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

interface ConnectionState {
  status: ConnectionStatus;
  lastEventAt: Date | null;
  unreadCount: number;
  setStatus: (status: ConnectionStatus) => void;
  recordEvent: () => void;
  clearUnread: () => void;
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
  status: "disconnected",
  lastEventAt: null,
  unreadCount: 0,
  setStatus: (status) => set({ status }),
  recordEvent: () =>
    set((state) => ({
      lastEventAt: new Date(),
      unreadCount: state.unreadCount + 1,
    })),
  clearUnread: () => set({ unreadCount: 0 }),
}));
