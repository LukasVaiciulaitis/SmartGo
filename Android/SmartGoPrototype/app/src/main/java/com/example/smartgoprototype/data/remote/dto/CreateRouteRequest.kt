package com.example.smartgoprototype.data.remote.dto

import com.squareup.moshi.Json

data class CreateRouteRequest(
    @field:Json(name = "title") val title: String,
    @field:Json(name = "origin") val origin: EndpointPlace,
    @field:Json(name = "destination") val destination: EndpointPlace,
    @field:Json(name = "intermediates") val intermediates: List<IntermediatePlace>?,
    @field:Json(name = "travelMode") val travelMode: String,
    @field:Json(name = "arriveBy") val arriveBy: String,
    @field:Json(name = "timezone") val timezone: String,
    @field:Json(name = "daysOfWeek") val daysOfWeek: List<String>
)

data class EndpointPlace(
    @field:Json(name = "placeId") val placeId: String,
    @field:Json(name = "label") val label: String,
    @field:Json(name = "addressComponents") val addressComponents: List<GoogleAddressComponentDto>
)

data class IntermediatePlace(
    @field:Json(name = "placeId") val placeId: String,
    @field:Json(name = "label") val label: String
)

data class GoogleAddressComponentDto(
    @field:Json(name = "longText") val longText: String,
    @field:Json(name = "shortText") val shortText: String?,
    @field:Json(name = "types") val types: List<String>
)