import type { StoryContent } from "../content";

export function buildStoryChapters(content: StoryContent) {
  return [
    {
      media: content.media,
      label: content.chapterLabel ?? "01",
      description: content.description,
      body: content.body,
    },
    ...(content.sequence ?? []).map((frame, index) => ({
      media: frame,
      label: frame.chapterLabel ?? String(index + 2).padStart(2, "0"),
      description: frame.copy ? frame.copy.description : content.description,
      body: frame.copy?.body ?? content.body,
    })),
  ];
}

export function setupStoryChapters(story: HTMLElement): () => void {
  const controls = story.querySelector<HTMLElement>("[data-story-tabs]");
  const buttons = [
    ...story.querySelectorAll<HTMLButtonElement>("[data-story-chapter]"),
  ];
  const images = [...story.querySelectorAll<HTMLElement>("[data-story-frame]")];
  const panels = [
    ...story.querySelectorAll<HTMLElement>("[data-story-copy-frame]"),
  ];
  if (
    !controls ||
    buttons.length < 2 ||
    images.length !== buttons.length ||
    panels.length !== buttons.length
  )
    return () => undefined;

  const select = (selected: number) => {
    buttons.forEach((button, index) => {
      button.setAttribute("aria-pressed", String(index === selected));
    });
    [images, panels].forEach((frames) => {
      frames.forEach((frame, index) => {
        const active = index === selected;
        if (active) frame.dataset.storyActive = "true";
        else delete frame.dataset.storyActive;
        frame.setAttribute("aria-hidden", String(!active));
      });
    });
    panels.forEach((panel, index) => {
      panel.inert = index !== selected;
    });
  };
  const handlers = buttons.map((button, index) => {
    const handler = () => select(index);
    button.addEventListener("click", handler);
    return handler;
  });
  select(0);
  story.dataset.storyReady = "true";
  controls.hidden = false;

  return () => {
    buttons.forEach((button, index) => {
      button.removeEventListener("click", handlers[index]);
    });
    select(0);
    delete story.dataset.storyReady;
    controls.hidden = true;
    panels.forEach((panel) => {
      panel.removeAttribute("aria-hidden");
      panel.inert = false;
    });
  };
}
