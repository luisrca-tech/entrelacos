# Block 7 recovery evidence

Status: `UNPROVEN`

Date: 2026-09-16

This record defines the recovery proof still required for EntreLaços. It is not backup evidence, a disaster-recovery guarantee, or approval to operate against development or production data.

## Current evidence

No real restore was executed in Block 7 because the following prerequisites were not available as verified inputs:

- selected Neon tier;
- confirmed backup retention window;
- accepted restore cost;
- an identified recoverable backup or point in time;
- authorized backup/restore access;
- a separate disposable destination whose project, branch, endpoint, database, role, and `neon.branch_id` can be verified before mutation.

Consequently, observed RPO and RTO are both `UNPROVEN`. The targets recorded in the implementation plan (RPO at most one hour and RTO at most eight hours) remain targets, not measured results.

## Required real exercise

A future authorized operator must record all of the following from one real exercise:

| Evidence | Required value |
| --- | --- |
| Source | Backup or point-in-time source identifier that does not disclose credentials |
| Recoverable moment | Timestamp selected for restoration |
| Source identity | Verified project, branch, endpoint, database, role, and branch ID |
| Destination identity | Separately verified disposable project, branch, endpoint, database, role, and branch ID |
| Isolation | Proof that destination differs from source and is not shared development or production |
| Start and finish | Operator-recorded restore timestamps |
| Observed RPO | Difference between the intended recoverable moment and the newest recovered durable record |
| Observed RTO | Difference between restore start and successful functional/isolation validation |
| Service assumptions | Neon tier, retention window, pricing/cost approval, and applicable limits |
| Functional validation | Schema, tenant sentinel, authentication/config preservation, and representative critical flows |
| Cleanup | Removal or approved retention of the disposable restored destination |

The exercise must fail closed before mutation if either identity is missing or ambiguous, if source and destination resolve to the same database/branch, or if the destination is not explicitly disposable.

## Gate

Owner: project owner and authorized infrastructure operator, not yet assigned in this record.

Next action: select the Neon tier and retention policy, accept cost, identify an authorized backup, provision a separate disposable destination, then execute and timestamp the exercise.

Release impact: any claim that recovery is proven, or that the RPO/RTO targets are met, remains blocked. This does not invalidate local reset, QA, load, or CI evidence.

## Listening

A theoretical runbook would not prove recoverability. This record therefore preserves the exact missing prerequisites and leaves both metrics unproven until a real isolated restoration is completed.
