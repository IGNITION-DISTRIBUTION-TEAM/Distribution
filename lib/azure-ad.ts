/**
 * Azure AD authentication utilities
 * Handles OAuth 2.0 Authorization Code Flow with PKCE
 */

export function getRedirectUri(): string {
  if (typeof window !== "undefined") {
    return `${window.location.origin}/api/auth/azure/callback`
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "")
  return `${appUrl}/api/auth/azure/callback`
}

/**
 * Azure AD single sign-out URL. Redirecting the browser here ends the
 * Microsoft session (not just our local cookie), so the next login prompts
 * for credentials instead of silently re-authenticating via SSO.
 *
 * NOTE: post_logout_redirect_uri must be registered as a "Front-channel logout
 * URL" / redirect URI in the Azure AD app registration, otherwise Azure shows
 * its generic sign-out page and does not redirect back.
 */
export function getAzureLogoutUrl(): string {
  const tenantId = process.env.NEXT_PUBLIC_AZURE_TENANT_ID
  if (!tenantId) throw new Error("Missing NEXT_PUBLIC_AZURE_TENANT_ID")

  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "")
  const postLogoutRedirectUri = `${origin}/`

  return (
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout?` +
    `post_logout_redirect_uri=${encodeURIComponent(postLogoutRedirectUri)}`
  )
}

export async function getAzureAuthUrl(): Promise<string> {
  const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID
  const tenantId = process.env.NEXT_PUBLIC_AZURE_TENANT_ID
  const redirectUri = getRedirectUri()

  if (!clientId) throw new Error("Missing NEXT_PUBLIC_AZURE_CLIENT_ID")
  if (!tenantId) throw new Error("Missing NEXT_PUBLIC_AZURE_TENANT_ID")

  const scope = encodeURIComponent("user.read openid profile email")
  const responseType = "code"
  const responseMode = "query"

  // Generate PKCE challenge
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)

  // Store code verifier in a cookie for later exchange
  // Use sessionStorage as fallback for development
  if (typeof window !== "undefined") {
    // Set cookie with short expiration
    document.cookie = `azure_code_verifier=${codeVerifier}; path=/; max-age=600; samesite=lax`
    sessionStorage.setItem("azure_code_verifier", codeVerifier)
  }

  const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    `client_id=${clientId}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=${responseType}&` +
    `scope=${scope}&` +
    `response_mode=${responseMode}&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256&` +
    `state=${generateState()}`

  return authUrl
}

export function generateCodeVerifier(): string {
  const length = 43 // Recommended length for PKCE
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  let codeVerifier = ""
  for (let i = 0; i < length; i++) {
    codeVerifier += charset.charAt(Math.floor(Math.random() * charset.length))
  }
  return codeVerifier
}

export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  // Use crypto.subtle (available in browser)
  const encoder = new TextEncoder()
  const data = encoder.encode(codeVerifier)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)

  // Convert to base64url
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashString = String.fromCharCode.apply(null, hashArray as any)
  const base64 = btoa(hashString)

  // Convert to base64url (replace +, / with -, _  and remove =)
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

export function generateState(): string {
  const randomValues = new Uint8Array(32)
  if (typeof window !== "undefined") {
    window.crypto.getRandomValues(randomValues)
  }
  return Array.from(randomValues, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{
  accessToken: string
  idToken: string
  refreshToken?: string
}> {
  const clientId = process.env.NEXT_PUBLIC_AZURE_CLIENT_ID
  const clientSecret = process.env.AZURE_CLIENT_SECRET
  const tenantId = process.env.NEXT_PUBLIC_AZURE_TENANT_ID

  if (!clientId || !clientSecret || !tenantId) {
    throw new Error("Missing Azure AD credentials")
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: "user.read openid profile email",
    }).toString(),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(`Azure AD token exchange failed: ${error.error_description}`)
  }

  const data = await response.json()

  return {
    accessToken: data.access_token,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
  }
}

export async function getUserProfile(accessToken: string): Promise<{
  id: string
  email: string
  displayName: string
}> {
  const response = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    throw new Error("Failed to fetch user profile")
  }

  const data = await response.json()

  return {
    id: data.id,
    email: data.userPrincipalName || data.mail,
    displayName: data.displayName,
  }
}

export function extractUserInfoFromToken(idToken: string): {
  email: string
  name: string
} {
  try {
    // Decode JWT (id token)
    const parts = idToken.split(".")
    if (parts.length !== 3) {
      throw new Error("Invalid token format")
    }

    const decoded = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf-8")
    )

    return {
      email: decoded.preferred_username || decoded.email || "",
      name: decoded.name || decoded.given_name || "User",
    }
  } catch (error) {
    throw new Error(`Failed to decode token: ${error}`)
  }
}
