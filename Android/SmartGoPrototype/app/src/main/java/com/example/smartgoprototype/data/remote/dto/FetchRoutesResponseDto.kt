package com.example.smartgoprototype.data.remote.dto

import com.squareup.moshi.Json

data class FetchRoutesResponseDto(
    @field:Json(name = "routes") val routes: List<FetchedRouteDto>
)

data class FetchedRouteDto(
    @field:Json(name = "routeId") val routeId: String,
    @field:Json(name = "title") val title: String,
    @field:Json(name = "origin") val origin: CreatedEndpointDto,
    @field:Json(name = "destination") val destination: CreatedEndpointDto,
    @field:Json(name = "schedule") val schedule: CreatedScheduleDto?
)
