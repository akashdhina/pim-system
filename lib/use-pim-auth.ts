"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

type PermissionMap = Record<string, boolean>;
type PimUser = {
  id: number;
  username: string;
  display_name: string;
  designation: string;
  role: string;
  role_code?: string;
  must_change_password?: boolean;
  session_expires_at?: string | null;
  isDevelopmentIdentity?: boolean;
};

export function usePimAuth() {
  const [permissions, setPermissions] =
    useState<PermissionMap>({});
  const [authenticated, setAuthenticated] =
    useState(false);
  const [user, setUser] =
    useState<PimUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshAuth = useCallback(async () => {
    try {
      const response = await fetch("/api/pim/auth/me", {
        cache: "no-store",
      });
      const json = await response.json();

      setAuthenticated(Boolean(response.ok && json.user));
      setUser(response.ok ? json.user || null : null);
      setPermissions(json.permissions || {});
    } catch {
      setAuthenticated(false);
      setUser(null);
      setPermissions({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadAuth() {
      try {
        const response = await fetch("/api/pim/auth/me", {
          cache: "no-store",
        });
        const json = await response.json();

        if (cancelled) return;

        setAuthenticated(Boolean(response.ok && json.user));
        setUser(response.ok ? json.user || null : null);
        setPermissions(json.permissions || {});
      } catch {
        if (!cancelled) {
          setAuthenticated(false);
          setUser(null);
          setPermissions({});
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadAuth();

    return () => {
      cancelled = true;
    };
  }, []);

  const hasPermission = useCallback(
    (permission: string) => Boolean(permissions[permission]),
    [permissions]
  );

  return useMemo(
    () => ({
      authenticated,
      hasPermission,
      loading,
      permissions,
      refresh: refreshAuth,
      refreshAuth,
      user,
    }),
    [
      authenticated,
      hasPermission,
      loading,
      permissions,
      refreshAuth,
      user,
    ]
  );
}
