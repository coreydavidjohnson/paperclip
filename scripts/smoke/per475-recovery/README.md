# PER-475 regression fixture

Integrated base: 1614b110d4cbe84340f074785fb3370f31533381.
Run from the fork worktree on Home Lab's assigned desktop. The runner uses
Home Lab's own SSH route to VM103 for kubectl; no production state or secrets
are mounted. The image is immutable, resources and duration are bounded, and
namespace deletion plus absence readback run on exit. Real embedded PostgreSQL
lives only in the disposable container. Source overlays exercise queue and
recovery logic; this is not a deployed-image or live OmniGenT acceptance test.

The six suites cover recovery actions, disposition repair, persisted legacy
continuation authority and queue
application/PostgreSQL adapter behavior. No cancelled canary is resumed or
replaced. Tests retain session IDs and saved-comment identity; they do not
prove uninterrupted provider-process lifetime or arbitrary external exactly-once
side effects. Existing recovery concurrent/lost-ack tests cover wake delivery.

Before promotion: review exact source SHA, run the fork candidate typecheck and
image gates, integrate on the latest production fork, update the infrastructure
pin through its CI and reconciler, then verify the actual live change.
