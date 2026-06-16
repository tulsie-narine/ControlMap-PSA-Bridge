# Microsoft Graph / Defender API — Compliance Evidence Gap Analysis

**Scope:** What is automatable from Microsoft Graph Security API, Defender for Endpoint API, Entra ID APIs, Intune, and related Microsoft 365 APIs for GRC frameworks: NIST CSF 2.0, CIS Controls v8, ISO 27001:2022, SOC 2 TSC, CMMC 2.0, and NIST 800-171.

**Verdict up front:** The current 12 checks are a solid starting point but cover roughly 40% of what is realistically automatable. There are at least **17 additional high-value checks** that can be built today from GA or well-established beta Graph/MDE endpoints.

---

## Current 12 checks — what they cover

| ID | Title | API family | Frameworks |
|---|---|---|---|
| DEF-AM-01 | Endpoint onboarding coverage | MDE | CIS 1/10, NIST ID.AM |
| DEF-AM-02 | AV/EDR health | MDE | CIS 10, NIST PR.PS |
| DEF-AM-03 | No stale devices | MDE | CIS 1.3, NIST ID.AM-08 |
| DEF-SS-01 | Secure Score posture | Graph Security | CIS 4/18, NIST PR.PS |
| DEF-SS-02 | Secure Score improvement actions | Graph Security | CIS 4, NIST PR.PS-02 |
| DEF-VM-01 | No unpatched critical/high CVEs | MDE | CIS 7.4, NIST ID.RA |
| DEF-VM-02 | Device exposure score | MDE | CIS 7, NIST ID.RA |
| DEF-TM-01 | Open incidents beyond SLA | Graph Security | CIS 17, NIST RS.MA |
| DEF-TM-02 | Active high-severity alerts | Graph Security | CIS 8.11, NIST DE.CM |
| DEF-ID-01 | Conditional Access MFA enforcement | Graph Identity | CIS 6.3, NIST PR.AA-03 |
| DEF-ID-02 | Risky users remediated | Graph Identity Protection | CIS 6.2, NIST ID.AM-07 |
| DEF-IC-01 | Intune device compliance rate | Graph Intune | CIS 4.1, NIST PR.PS |

---

## Gap analysis — 17 additional automatable checks

Organized by domain, from highest GRC value to lowest.

---

### Domain A: Privileged Access Governance (HIGH VALUE — completely absent today)

#### DEF-PA-01 — Excessive Global Administrator assignments
**Why it matters:** CIS Control 5.4 and nearly every framework cite over-provisioned global admin as a top identity risk. PIM's own "tooManyGlobalAdmins" alert fires automatically when thresholds are exceeded.

- **API:** `GET /beta/roleManagement/directory/roleAssignments?$filter=roleDefinitionId eq '<global-admin-id>'` and `GET /beta/security/alerts_v2?$filter=category eq 'privilegedIdentityManagement'`
- **PIM alert resource:** `tooManyGlobalAdminsAssignedToTenantAlertConfiguration` (beta)
- **Evidence produced:** Count of global admin assignments; names of all permanent global admins; PIM alert status
- **Threshold:** Best practice = 2–5 named accounts; more than 5 is a fail
- **Frameworks:** CIS 5.4, NIST CSF PR.AA-05, ISO A.9.2.3, SOC2 CC6.3, CMMC AC.L2-3.1.5
- **License:** Entra ID P2 / PIM

#### DEF-PA-02 — Permanent active privileged role assignments (no JIT)
**Why it matters:** JIT (just-in-time) access is a core zero-trust and CMMC requirement. Permanent active assignments for privileged roles (Global Admin, Security Admin, Exchange Admin, etc.) fail this control.

- **API:** `GET /roleManagement/directory/roleAssignments?$expand=roleDefinition&$filter=roleDefinition/isBuiltIn eq true`; filter where `directoryScopeId eq '/'` and assignment is not time-bounded
- **PIM alert:** `permanentActiveAssignmentAlert` (beta)
- **Evidence produced:** List of permanent active privileged role holders with role name, user, and assignment date
- **Frameworks:** CIS 5.4, NIST CSF PR.AA-05, 800-171 3.1.6, CMMC AC.L2-3.1.6, ISO A.9.2.3, SOC2 CC6.3

---

### Domain B: MFA & Authentication Hygiene (HIGH VALUE — current checks only verify policy existence, not adoption)

#### DEF-ID-03 — MFA registration coverage rate
**Why it matters:** DEF-ID-01 checks whether a CA policy enforcing MFA *exists*, but a CA policy with exclusions or gaps may leave large populations unprotected. This check measures actual % of users registered for strong MFA.

- **API:** `GET /reports/authenticationMethods/userRegistrationDetails` (requires Entra P1/P2)
  - Returns per-user: `isMfaRegistered`, `isMfaCapable`, `isPasswordlessCapable`, `methodsRegistered[]`
- **Aggregate endpoint:** `GET /reports/authenticationMethods/usersRegisteredByFeature`
  - Returns count of users registered/enabled/capable for MFA, SSPR, passwordless
- **Evidence produced:** % of users MFA-capable; breakdown by method (Authenticator, FIDO2, phone, etc.); users with no MFA method registered
- **Frameworks:** CIS 6.3, NIST CSF PR.AA-03, 800-171 3.5.3, CMMC IA.L2-3.5.3, ISO A.9.4.2, SOC2 CC6.1

#### DEF-ID-04 — Legacy authentication blocked
**Why it matters:** Legacy auth protocols (SMTP AUTH, POP3, IMAP, Basic Auth) bypass MFA entirely. CISA SCuBA and CIS M365 Benchmark both flag this as critical. A CA policy must exist that explicitly blocks `legacyAuthenticationClients`.

- **API (policy check):** `GET /identity/conditionalAccess/policies` — look for enabled policies where `conditions.clientAppTypes` includes `exchangeActiveSync` or `other`, with `grantControls.builtInControls` = `block`
- **API (detection):** `GET /auditLogs/signIns?$filter=clientAppUsed ne 'Browser' and clientAppUsed ne 'Mobile Apps and Desktop clients'&$top=1` — confirms legacy auth is still occurring even if policy exists (policy gaps/exclusions)
- **Evidence produced:** Policy existence; count of legacy auth sign-ins in last 30 days; affected users/apps
- **Frameworks:** CIS 6.3, NIST CSF PR.AA, ISO A.9.4.2, SOC2 CC6.1, CMMC IA.L2-3.5.3

#### DEF-ID-05 — Microsoft Authenticator anti-MFA-fatigue configuration
**Why it matters:** MFA push notification fatigue is a common attack vector (Lapsus$, Uber breach). Microsoft Authenticator can show app name and location in notifications, and require number matching. These are CIS-recommended settings.

- **API:** `GET /policies/authenticationMethodsPolicy/authenticationMethodConfigurations/microsoftAuthenticator`
- **Evidence produced:** Whether `displayAppInformationRequiredState` and `displayLocationInformationRequiredState` are `enabled`; whether `numberMatchingRequiredState` is on (now default but verifiable)
- **Frameworks:** CIS 6.4, NIST CSF PR.AA-03, ISO A.9.4.2

---

### Domain C: Identity Governance (HIGH VALUE — absent today)

#### DEF-ID-06 — Guest user inventory and stale guest governance
**Why it matters:** Unreviewed external guest accounts are a persistent ISO 27001, SOC 2, and NIST risk. Auditors routinely ask for evidence that guest access is reviewed and stale accounts removed.

- **API:** `GET /users?$filter=userType eq 'Guest'&$select=displayName,userPrincipalName,createdDateTime,signInActivity,externalUserState`
- **Check logic:** Count guests; flag guests who have never signed in or last signed in >90 days ago (configurable)
- **Evidence produced:** Total guest count; stale guests list with last sign-in; external domains represented
- **Frameworks:** CIS 6.1, NIST CSF PR.AA-01, ISO A.9.2.1, ISO A.9.2.5, SOC2 CC6.2, CMMC AC.L1-3.1.1

#### DEF-ID-07 — Risky service principals
**Why it matters:** Service principals (app identities, managed identities, automation accounts) are an increasingly targeted vector. Entra ID Protection now surfaces risky service principals separately from risky users.

- **API:** `GET /identityProtection/riskyServicePrincipals?$filter=riskState eq 'atRisk'`
  - Returns: `displayName`, `appId`, `riskLevel`, `riskState`, `riskLastUpdatedDateTime`
- **Evidence produced:** Count and details of at-risk service principals; risk levels; last update
- **Frameworks:** CIS 5.3, NIST CSF ID.AM-07, ISO A.9.2.6, SOC2 CC6.1

#### DEF-IG-01 — Privileged role access reviews
**Why it matters:** Most audited frameworks (SOC 2 CC6.3, ISO A.9.2.5, CMMC AC.L2-3.1.5) require periodic formal review of who has privileged access. Entra Identity Governance Access Reviews API lets you verify these exist and are active.

- **API:** `GET /identityGovernance/accessReviews/definitions?$filter=scope/query eq '/v1.0/roleManagement/directory/roleAssignments'`
- **Check logic:** At least one recurring access review exists for privileged roles (Global Admin, Security Admin, etc.)
- **Evidence produced:** List of active access review definitions; scope, frequency, reviewers, last completed date
- **Frameworks:** CIS 5.4, NIST CSF PR.AA-05, ISO A.9.2.5, SOC2 CC6.3, CMMC AC.L2-3.1.5
- **License:** Entra ID P2

---

### Domain D: Application & Credential Governance (ABSENT today)

#### DEF-GV-03 — App registration client secrets expiry
**Why it matters:** Expired or soon-to-expire client secrets cause service outages and are a governance red flag. Microsoft even surfaces this as a built-in Entra recommendation. Best practice is <12-month secret lifetimes.

- **API:** `GET /applications?$select=displayName,appId,passwordCredentials`
- **Check logic:** Flag any `passwordCredential.endDateTime` within the next 30 days (configurable), or secrets with lifetime >1 year
- **Evidence produced:** Apps with expiring/expired secrets; secret age distribution; apps with no expiry set
- **Frameworks:** CIS 5.3, NIST CSF PR.AA-02, ISO A.9.4.3, SOC2 CC6.1

#### DEF-GV-04 — Service principal secrets expiry
**Why it matters:** Same as above but for enterprise applications / service principals, which often have higher-privilege access.

- **API:** `GET /servicePrincipals?$select=displayName,appId,passwordCredentials&$filter=tags/any(t: t eq 'WindowsAzureActiveDirectoryIntegratedApp')`
- **Evidence produced:** Service principals with expiring credentials; apps with secrets >12 months old
- **Frameworks:** CIS 5.3, NIST CSF PR.AA-02, ISO A.9.4.3, SOC2 CC6.1

---

### Domain E: MDE Vulnerability Management — Deeper Checks

#### DEF-VM-03 — Security baseline compliance (CIS/STIG per device)
**Why it matters:** DEF-VM-01 covers CVEs; this covers *configuration drift* against CIS benchmarks. MDE Vulnerability Management's baseline assessment profiles let you see how many devices pass/fail CIS Level 1/2 or STIG profiles — exactly the kind of evidence auditors want for CIS Controls 4 and CMMC CM.L2.

- **API:** `GET /api/baselineProfiles` (MDE) → get profile IDs and `passedDevices/totalDevices`
  - `GET /api/baselineConfigurations?profileId={id}` → per-setting compliance detail
- **Evidence produced:** Profile name, benchmark (CIS/STIG/custom), OS, total devices, % passed; failed configuration settings
- **Frameworks:** CIS 4.1, CIS 4.2, NIST CSF PR.PS-01, 800-171 3.4.1, CMMC CM.L2-3.4.1, ISO A.8.9

#### DEF-VM-04 — End-of-life / end-of-support software
**Why it matters:** Running EOL software is an explicit finding in CIS 7.6 and NIST ID.AM-02. Patching can't fix EOL software; it must be removed or formally risk-accepted.

- **API:** `GET /api/software?$filter=isEol eq true` (MDE) — lists EOL products across the fleet
- **Evidence produced:** EOL software names, vendor, version, affected device count, EOL date
- **Frameworks:** CIS 7.6, NIST CSF ID.AM-02, ISO A.8.8, SOC2 CC7.1

#### DEF-VM-05 — Security recommendations backlog
**Why it matters:** The recommendations API surfaces actionable remediations ranked by exposure reduction. This is distinct from CVEs — it covers misconfigurations, missing patches, exposed services.

- **API:** `GET /api/recommendations?$filter=severity eq 'Critical' and status eq 'Active'` (MDE)
- **Evidence produced:** Count/list of active critical recommendations; remediation type; exposed devices count; related CVEs
- **Frameworks:** CIS 4, CIS 7, NIST CSF ID.RA-04, ISO A.8.8, CMMC CM.L2-3.4.2

---

### Domain F: Audit & Monitoring (ABSENT today)

#### DEF-AL-01 — Microsoft Purview Audit availability
**Why it matters:** Every framework (SOC 2 CC7.2, NIST CSF DE.AE-03, ISO A.8.15, CMMC AU.L2-3.3.1) requires that audit logging is enabled and accessible. This is a foundational "is auditing on?" check.

- **API:** `GET /security/auditLog/queries` — if this returns results, Purview Audit is licensed and accessible; run a test query with a short time window
- **Alternative:** `GET /beta/auditLogs/directoryAudits?$top=1` — simpler availability check
- **Evidence produced:** Confirmation audit is accessible; retention period; coverage of key workloads
- **Frameworks:** CIS 8.2, NIST CSF DE.AE-03, NIST CSF GV.OC-03, ISO A.8.15, SOC2 CC7.2, CMMC AU.L2-3.3.1

#### DEF-AL-02 — Legacy authentication sign-in activity
**Why it matters:** Complements DEF-ID-04 (policy check) with detection evidence. Even with a CA block policy, exclusions or legacy apps may still be authenticating. This shows whether it's actually happening.

- **API:** `GET /auditLogs/signIns?$filter=isInteractive eq false and clientAppUsed ne 'Mobile Apps and Desktop clients' and clientAppUsed ne 'Browser'&$top=100`
- **Evidence produced:** Count of non-interactive, non-modern-auth sign-ins; affected users and apps; protocols used (SMTP, IMAP, POP3, etc.)
- **Frameworks:** CIS 6.3, NIST CSF DE.CM-01, ISO A.8.16, SOC2 CC7.2

---

### Domain G: Email Security & Security Awareness (ABSENT today)

#### DEF-AS-01 — Attack simulation / phishing training coverage
**Why it matters:** CIS Control 14.2 (security awareness training) and ISO A.6.3 require evidence that users receive security awareness training. Attack Simulation Training is the only Microsoft 365 API that can provide automated evidence of training completion rates.

- **API:** `GET /security/attackSimulation/simulations` (Graph v1.0)
  - `GET /security/attackSimulation/simulations/{id}/report/overview`
- **Check logic:** At least one simulation run in the last 12 months (configurable); % of users targeted; phish click rate; training completion rate
- **Evidence produced:** Simulation count, last run date, user engagement rates, training completion %, compromised credentials rate
- **Frameworks:** CIS 14.2, NIST CSF PR.AT-01, ISO A.6.3, SOC2 CC1.4

---

### Domain H: Defender for Identity (bonus — available in E5/MDI)

#### DEF-HI-01 — Defender for Identity health issues
**Why it matters:** MDI sensors are the detection engine for lateral movement, pass-the-hash, DCsync, and Active Directory reconnaissance. Unhealthy sensors = blind spots in your hybrid environment detection.

- **API:** `GET /security/identities/healthIssues` (Graph v1.0 — GA as of early 2025)
- **Evidence produced:** Count and severity of MDI sensor health issues; issue type; affected sensor/DC; remediation guidance
- **Frameworks:** NIST CSF DE.CM-06, ISO A.8.16, SOC2 CC7.1

---

## Summary: current coverage vs. full potential

| Domain | Current checks | Possible checks | Gap |
|---|---|---|---|
| Endpoint (MDE device health) | 3 (AM-01/02/03) | 3 | ✅ Good |
| Vulnerability management | 2 (VM-01/02) | 5 (+VM-03/04/05) | ⚠️ Missing baselines, EOL, recommendations |
| Secure Score | 2 (SS-01/02) | 2 | ✅ Good |
| Threat detection (incidents/alerts) | 2 (TM-01/02) | 2 | ✅ Good |
| Conditional Access / MFA | 1 (ID-01) | 4 (+ID-03/04/05) | ❌ Missing registration rate, legacy auth, fatigue |
| Risky identities | 1 (ID-02) | 3 (+ID-06/07) | ⚠️ Missing guests, risky SPs |
| Privileged access governance | 0 | 3 (PA-01/02, IG-01) | ❌ Completely absent |
| App/credential governance | 0 | 2 (GV-03/04) | ❌ Completely absent |
| Intune compliance | 1 (IC-01) | 1 | ✅ Good |
| Audit logging | 0 | 2 (AL-01/02) | ❌ Completely absent |
| Email / phishing training | 0 | 1 (AS-01) | ❌ Absent |
| MDI health | 0 | 1 (HI-01) | ❌ Absent (E5 only) |
| **TOTAL** | **12** | **29** | **17 gaps** |

---

## Framework coverage after adding all 29 checks

| Framework | Controls automated | Notes |
|---|---|---|
| **CIS Controls v8** | ~18 of top 20 safeguards | Gaps in CIS 3 (data protection, DLP) and CIS 16 (application security) |
| **NIST CSF 2.0** | GV.RM, ID.AM, ID.RA, PR.AA, PR.PS, PR.AT, DE.CM, DE.AE, RS.MA, RS.AN | Recover (RC) functions are entirely non-automatable from this stack |
| **ISO 27001:2022** | A.5.9, A.5.12, A.6.3, A.8.7–A.8.9, A.8.15–A.8.16, A.9.2, A.9.4 | A.7 (physical), A.10 (crypto), A.12 (supplier) not automatable |
| **SOC 2 TSC** | CC1.4, CC6.1–6.3, CC6.8, CC7.1–7.4, CC9.1 | CC4 (monitoring), CC5 (change mgmt) need supplemental evidence |
| **CMMC 2.0 / 800-171** | AC.L1–L2, IA.L1–L2, SI.L1–L2, AU.L2, CM.L2, IR.L2 | CA (security assessment), MA (maintenance), PE (physical) not covered |

---

## What Graph APIs cannot prove

Even with all 29 checks, auditors will still need human-produced evidence for:

- Policies have been *formally approved* by management
- Incident lessons learned were *documented and acted upon*
- Backup and recovery actually *worked* (tested)
- Risk acceptance decisions were made for any exceptions
- Vendor/supplier security assessments were conducted
- Physical security controls (badge access, server room logs)
- Security training *content* quality (only completion rates are automatable)

---

## Recommended build priority

**Phase 1 (immediate — high impact, all GA endpoints):**
1. DEF-ID-03 — MFA registration rate
2. DEF-ID-04 — Legacy authentication blocked (policy + detection)
3. DEF-PA-01 — Excessive Global Admin assignments
4. DEF-PA-02 — Permanent active privileged role assignments
5. DEF-GV-03 — App registration secrets expiry
6. DEF-VM-03 — Security baseline compliance (CIS/STIG)

**Phase 2 (high value, some beta endpoints):**
7. DEF-ID-06 — Guest user governance
8. DEF-AL-01 — Audit log availability
9. DEF-VM-04 — EOL software inventory
10. DEF-VM-05 — Security recommendations backlog
11. DEF-AS-01 — Attack simulation coverage

**Phase 3 (good-to-have, license-dependent):**
12. DEF-ID-05 — Authenticator anti-fatigue settings
13. DEF-ID-07 — Risky service principals
14. DEF-IG-01 — Privileged access reviews (Entra P2)
15. DEF-GV-04 — Service principal secrets expiry
16. DEF-AL-02 — Legacy auth sign-in detection
17. DEF-HI-01 — MDI sensor health (E5/MDI license)

---

## API reference table for new checks

| Check ID | Endpoint | API Family | Key Permission |
|---|---|---|---|
| DEF-PA-01 | `GET /beta/roleManagement/directory/roleAssignments` | Graph (beta) | `RoleManagement.Read.Directory` |
| DEF-PA-02 | `GET /roleManagement/directory/roleAssignments` | Graph v1.0 | `RoleManagement.Read.Directory` |
| DEF-ID-03 | `GET /reports/authenticationMethods/usersRegisteredByFeature` | Graph v1.0 | `AuditLog.Read.All`, `Reports.Read.All` |
| DEF-ID-04 | `GET /auditLogs/signIns` | Graph v1.0 | `AuditLog.Read.All` |
| DEF-ID-05 | `GET /policies/authenticationMethodsPolicy/authenticationMethodConfigurations/microsoftAuthenticator` | Graph v1.0 | `Policy.Read.All` |
| DEF-ID-06 | `GET /users?$filter=userType eq 'Guest'` | Graph v1.0 | `User.Read.All` |
| DEF-ID-07 | `GET /identityProtection/riskyServicePrincipals` | Graph v1.0 | `IdentityRiskEvent.Read.All` |
| DEF-IG-01 | `GET /identityGovernance/accessReviews/definitions` | Graph v1.0 | `AccessReview.Read.All` |
| DEF-GV-03 | `GET /applications` | Graph v1.0 | `Application.Read.All` |
| DEF-GV-04 | `GET /servicePrincipals` | Graph v1.0 | `Application.Read.All` |
| DEF-VM-03 | `GET /api/baselineProfiles` | MDE API | `SecurityBaselinesAssessment.Read.All` |
| DEF-VM-04 | `GET /api/software?$filter=isEol eq true` | MDE API | `Software.Read.All` |
| DEF-VM-05 | `GET /api/recommendations` | MDE API | `SecurityRecommendation.Read.All` |
| DEF-AL-01 | `GET /security/auditLog/queries` | Graph v1.0 | `AuditLogsQuery.Read.All` |
| DEF-AL-02 | `GET /auditLogs/signIns` | Graph v1.0 | `AuditLog.Read.All` |
| DEF-AS-01 | `GET /security/attackSimulation/simulations` | Graph v1.0 | `AttackSimulation.Read.All` |
| DEF-HI-01 | `GET /security/identities/healthIssues` | Graph v1.0 | `SecurityIdentitiesHealth.Read.All` |

---

*Sources: Microsoft Graph Security API overview (learn.microsoft.com), MDE Baseline Assessment Profiles API, Authentication Methods Usage Insights API, Identity Protection API overview, PIM Security Alerts (tooManyGlobalAdminsAssignedToTenantAlertConfiguration), CIS Benchmark compliance via Graph API (michev.info), Microsoft Purview Audit API, Attack Simulation and Training API.*
