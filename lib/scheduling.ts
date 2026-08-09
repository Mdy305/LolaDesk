export interface ServicePhases {
  activeDuration1Min: number;
  processingDurationMin: number;
  activeDuration2Min: number;
}

export function calculateSecondarySlot(
  primaryStartTime: Date,
  phases: ServicePhases
) {
  const applicationEnd = new Date(
    primaryStartTime.getTime() + phases.activeDuration1Min * 60000
  );
  
  const processingEnd = new Date(
    applicationEnd.getTime() + phases.processingDurationMin * 60000
  );

  const totalAppointmentEnd = new Date(
    processingEnd.getTime() + phases.activeDuration2Min * 60000
  );

  return {
    gapAvailableStart: applicationEnd,
    gapAvailableEnd: processingEnd,
    maxGapServiceMinutes: phases.processingDurationMin,
    totalAppointmentEnd,
  };
}
