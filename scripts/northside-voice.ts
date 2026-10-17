import type { TenantSettings } from "@/server/db";

/** Settings that used to be hardcoded for HVAC in the voice code. */
export const NORTHSIDE_VOICE: Partial<TenantSettings> = {
  bookingNoun: "free in-home visit",
  outboundReasons: {
    ac_replacement: "a quote for replacing your air conditioning",
    heat_pump: "switching to a heat pump",
    furnace_tuneup: "a furnace tune-up before winter",
    maintenance_plan: "our maintenance plan",
  },
  domainTerms: [
    "a/c", "ac", "air con", "air conditioner", "air conditioning", "furnace", "boiler", "heat pump", "hvac",
    "thermostat", "duct", "ducts", "ductwork", "condenser", "compressor", "vent", "vents", "radiator", "mini split", "filter",
  ],
};

