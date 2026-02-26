package com.example.smartgoprototype.domain.model

import java.time.DayOfWeek

/**
 * When and how often a route should be considered "active".
 *
 * Representation choices:
 * - [arriveByMinutes] stores minutes since local midnight (0..1439)
 * - [timeZoneId] stores an IANA zone ID (e.g., "Europe/Dublin") so "arrive by" can be interpreted correctly
 *   if the device travels or if server-side scheduling is introduced later.
 */
data class RouteSchedule(
    val arriveByMinutes: Int,
    val activeDays: Set<DayOfWeek>,
    val timeZoneId: String
)
