import type { SourceControlIcon } from "@t3tools/source-control-core/shared/definition";

// The view box starts at -39.666 to move the mark in, as the published artwork's group does.
export const icon: SourceControlIcon = {
  viewBox: "-39.666 -39.666 240 240",
  paths: [
    { d: "M-39.666 80.334a120 120 0 1 0 240 0a120 120 0 1 0-240 0z", fill: "#FF3333" },
    {
      d: "M0 32.1336L47.6983 0L34.2206 62.7383L8.03453 80.334L71.5475 123.011L47.6983 160.668L0 128.534V32.1336ZM139.397 71.4396L152.633 80.334L89.1205 123.011L112.97 160.668L160.668 128.534V37.6573L139.397 71.4396Z",
      fill: "white",
      fillRule: "evenodd",
    },
    {
      d: "M114.728 80.331H92.134L103.833 25.8731L69.5401 80.3359H46.9462L61.5056 12.5522H106.695H157.405L114.728 80.331Z",
      fill: "white",
      fillRule: "evenodd",
    },
  ],
};
