"use client";

import { useEffect, useState } from "react";
import { getMatrixBillingSuccessRedirectUrl } from "@/lib/billing";

export function useBillingRedirectUrl(): string | null {
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);

  useEffect(() => {
    setRedirectUrl(getMatrixBillingSuccessRedirectUrl());
  }, []);

  return redirectUrl;
}
