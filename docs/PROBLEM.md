Autonomous Merchant Onboarding Platform

Customer Context:
A payment company onboards merchants through a sequence of identity, tax, bank-account, risk and business checks. Information arrives through forms and documents. External verification providers return asynchronous responses, and internal systems create merchant identifiers and configure payment capabilities. Incomplete documents, provider outages and inconsistent statuses create manual work and delays.

Illustrative end-to-end user journey:
A merchant submits an application and supporting documents.
The system extracts relevant fields and validates completeness and consistency.
It invokes simulated PAN, GST, bank and risk verification APIs.
It tracks asynchronous callbacks and updates the application state.
It requests missing information or routes exceptions to a human reviewer.
Once required checks pass, it simulates merchant ID creation and records an audit trail.

Core requirements:
Accept an application and sample documents or structured document payloads.
Extract key fields and show confidence or validation status.
Call at least two simulated verification services.
Maintain explicit application states and transition rules.
Handle asynchronous callback events.
Provide an operator view of status, missing information and exceptions.
Simulate approval and merchant ID creation only when configured checks pass.

Advanced / stretch requirements:
Use multimodal extraction for images or PDFs.
Add duplicate application detection and entity matching.
Implement a durable workflow or event-driven state machine.
Use a human-in-the-loop review queue for low-confidence or high-risk cases.
Add retry policies, dead-letter handling and audit history.
Show operational metrics such as time in state and exception rate.

Failure and exception scenarios:
PAN verification succeeds but GST verification fails.
The same callback arrives multiple times.
A callback arrives after the request timed out.
The merchant changes bank details after verification.
Approval succeeds but merchant ID creation fails.
A document is blurred or conflicts with the application form.

Minimum successful demonstration:
Demonstrate one application from submission through verification to approval or justified escalation, including at least one asynchronous callback and one exception path.

What this challenge is designed to reveal:
Evaluates workflow design, document intelligence, state management, integration resilience, human review and responsible handling of sensitive onboarding information.

Scope note: Build a coherent, working vertical slice. You are not expected to implement every enterprise feature or production-scale infrastructure in 48 hours. Clearly identify assumptions, mocked dependencies and limitations.