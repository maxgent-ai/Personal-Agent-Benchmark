# Data image for one task: tasks/<id>/ (recording, rules, task card, grading) at /task. Built with
# the task directory as context by deploy/build-images.sh. Run with a volume at /out, it copies the
# task there for the replay service to read at /task (docs/deploy.md).
# The replay image's base: nothing else to pull, and it shares its layers with the replay image.
FROM node:22-slim
COPY . /task/
CMD ["cp", "-R", "/task/.", "/out/"]
