package com.example.smartgoprototype.domain.model

data class GoogleAddressComponent(
    val longText: String,
    val shortText: String?,
    val types: List<String>
)