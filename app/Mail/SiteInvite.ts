import { config } from '@stacksjs/config'
import { mail, template } from '@stacksjs/email'
import { normalizeOrigin } from '../Analytics/install'

export interface SiteInviteOptions {
  /** The invited address. Also the only account that may redeem the link. */
  to: string
  siteName: string
  /** Who sent it, for the "X invited you" line. Falls back to the site name. */
  invitedBy?: string | null
  /** `viewer` or `admin`, rendered as a plain-English sentence. */
  role: string
  /** The RAW token. It exists here and in the email, and nowhere else. */
  token: string
  /** When the link stops working, already formatted for a human. */
  expiresLabel: string
}

/** "read the reports" rather than "viewer" — the recipient has no glossary. */
function describeRole(role: string): string {
  return role === 'admin'
    ? 'view the reports and change settings, goals and sharing'
    : 'view the reports'
}

/**
 * Email someone an invitation to a site.
 *
 * The link is the credential, and this is its only delivery. That has two
 * consequences worth stating: the raw token must never be logged from here, and
 * a failed send must be visible to the caller, because an invitation whose
 * email did not arrive is an invitation that does not exist. `mail.send` reports
 * transport failure in its return value rather than throwing — the driver
 * catches internally — so ignoring that value would count a lost invitation as
 * delivered.
 */
export async function sendSiteInvite(options: SiteInviteOptions): Promise<boolean> {
  const { to, siteName, invitedBy, role, token, expiresLabel } = options

  const appName = config.app?.name || 'analyticshq'
  // normalizeOrigin because config.app.url is stored without a scheme, and a
  // scheme-less href in an email resolves against the mail client, not us.
  const appUrl = normalizeOrigin(config.app?.url || 'https://analyticshq.org')
  // Query, not a path segment: this app has no dynamic-param views, and `?token=`
  // matches the shape the dashboard share link already uses. resources/views/
  // invite.stx is what serves it.
  const acceptUrl = `${appUrl}/invite?token=${encodeURIComponent(token)}`
  const inviter = (invitedBy ?? '').trim()
  const subject = inviter
    ? `${inviter} invited you to ${siteName} on ${appName}`
    : `You have been invited to ${siteName} on ${appName}`

  const { html, text } = await template('site-invite', {
    variables: {
      appName,
      siteName,
      inviter,
      roleDescription: describeRole(role),
      acceptUrl,
      expiresLabel,
      year: new Date().getFullYear(),
    },
    subject,
  })

  const result = await mail.send({
    to: [to],
    from: {
      name: config.email?.from?.name || appName,
      address: config.email?.from?.address || 'hello@analyticshq.org',
    },
    subject,
    html,
    text,
  })

  return result?.success !== false
}

export default sendSiteInvite
