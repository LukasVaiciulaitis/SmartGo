package com.example.smartgoprototype.domain.model

/**
 * Domain representation of a user-defined route.
 *
 */
data class Route(
    val id: String,
    val title: String,
    val origin: PlaceLocation,
    val destination: PlaceLocation,
    val travelMode: TravelMode,
    val userActive: Boolean,
    val schedule: RouteSchedule
)
