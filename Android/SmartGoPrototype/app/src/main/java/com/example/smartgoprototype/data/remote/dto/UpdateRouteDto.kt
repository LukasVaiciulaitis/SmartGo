package com.example.smartgoprototype.data.remote.dto

import com.squareup.moshi.Json

// Used by EditRouteViewModel - updates title, travel mode, and schedule together.
// No userActive field: the edit form never changes active state.
data class EditRouteRequestDto(
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "title") val title: String,
    @field:Json(name = "travelMode") val travelMode: String,
    @field:Json(name = "arriveBy") val arriveBy: String,
    @field:Json(name = "timezone") val timezone: String,
    @field:Json(name = "daysOfWeek") val daysOfWeek: List<String>
)

// Used when title changed but travelMode and schedule did not — only title is sent so the
// backend sees no forecast-affecting fields and skips forecast invalidation.
data class UpdateRouteTitleDto(
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "title") val title: String
)

// Used when travelMode changed but schedule did not — omits schedule fields so the backend
// does not see arriveBy/timezone/daysOfWeek (travelMode correctly triggers invalidation).
data class UpdateRouteMetaDto(
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "title") val title: String,
    @field:Json(name = "travelMode") val travelMode: String
)

// Used by DashboardViewModel.toggleRouteActive - only flips the active flag.
data class ToggleActiveRequestDto(
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "userActive") val userActive: Boolean
)

// Used by DashboardViewModel.toggleDay - only updates the schedule days (and timezone).
data class UpdateScheduleRequestDto(
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "timezone") val timezone: String,
    @field:Json(name = "daysOfWeek") val daysOfWeek: List<String>
)

data class UpdateRouteResponseDto(
    @field:Json(name = "message") val message: String,
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "updates") val updates: List<String>? = null
)
