package com.example.smartgoprototype.data.remote.dto

import com.squareup.moshi.Json

data class CreateRouteResponseDto(
    @field:Json(name = "message") val message: String,
    @field:Json(name = "route") val route: RouteCreatedDto
)

data class RouteCreatedDto(
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "title") val title: String,
    @field:Json(name = "origin") val origin: CreatedEndpointDto,
    @field:Json(name = "destination") val destination: CreatedEndpointDto,
    @field:Json(name = "travelMode") val travelMode: String,
    @field:Json(name = "schedule") val schedule: CreatedScheduleDto
)

data class CreatedEndpointDto(
    @field:Json(name = "label") val label: String,
    @field:Json(name = "placeId") val placeId: String
)

data class CreatedScheduleDto(
    @field:Json(name = "arriveBy") val arriveBy: String,
    @field:Json(name = "timezone") val timezone: String,
    @field:Json(name = "daysOfWeek") val daysOfWeek: List<String>
)