export type {
  FooterContent,
  GalleryContent,
  GalleryControls,
  GalleryItem,
  HeroAction,
  HeroContent,
  HeroIntroContent,
  HomeSectionKey,
  ImageMedia,
  Media,
  Navigation,
  NavigationLink,
  PageSeo,
  PracticalGuidance,
  RobotsDirective,
  ScheduleContent,
  ScheduleEntry,
  SectionContent,
  SiteIdentity,
  SocialImage,
  StoryContent,
  VenueContent,
  VenueLabels,
  VideoMedia,
  WeddingHomeProps,
  WeddingLayoutProps,
} from "./content";

export {
  validateFooterContent,
  validateGalleryContent,
  validateGoogleMapsDirectionsUrl,
  validateHeroContent,
  validateMapEmbedUrl,
  validateMedia,
  validateNavigation,
  validatePageSeo,
  validateScheduleContent,
  validateSectionContent,
  validateSectionIds,
  validateSerializableContent,
  validateSiteIdentity,
  validateStoryContent,
  validateVenueContent,
  validateWeddingHomeProps,
  validateWeddingLayoutProps,
} from "./content";

export { default as WeddingLayout } from "./layouts/WeddingLayout.astro";
export { default as WeddingHome } from "./pages/WeddingHome.astro";
export { default as DetailsSection } from "./sections/DetailsSection.astro";
export { default as GallerySection } from "./sections/GallerySection.astro";
export { default as HeroSection } from "./sections/HeroSection.astro";
export { default as ScheduleSection } from "./sections/ScheduleSection.astro";
export { default as StorySection } from "./sections/StorySection.astro";
export { default as TemplateSection } from "./sections/TemplateSection.astro";
export { default as VenueSection } from "./sections/VenueSection.astro";
